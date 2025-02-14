import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import FirecrawlApp, { SearchResponse } from "@mendable/firecrawl-js"
import { generateObject, LanguageModel, Message, streamText } from "ai"
import { z } from "zod"
import pLimit from "p-limit"

import { ExtensionMessage } from "../../shared/ExtensionMessage"
import { ResearchTaskPayload } from "../../shared/WebviewMessage"
import { ClineProvider } from "../../core/webview/ClineProvider"

import {
	ResearchInquiry,
	ResearchStep,
	ResearchProgress,
	ResearchResult,
	researchLearningsSchema,
	researchQuerySchema,
	ResearchLearnings,
	ResearchQuery,
} from "./types"
import { truncatePrompt, trimPrompt } from "./utils/prompt"
import { getTreeSize } from "./utils/progress"

export class DeepResearchService {
	public readonly providerId: string
	public readonly providerApiKey: string
	public readonly firecrawlApiKey: string
	public readonly modelId: string
	public readonly breadth: number
	public readonly depth: number
	public readonly concurrency: number

	private providerRef: WeakRef<ClineProvider>
	private firecrawl: FirecrawlApp
	private model: LanguageModel
	private _status: "idle" | "followUp" | "research" | "done" | "aborted" = "idle"

	private inquiry: ResearchInquiry = { followUps: [], responses: [] }
	private progress: ResearchProgress = { expectedQueries: 0, completedQueries: 0, progressPercentage: 0 }
	private messages: Message[] = []

	constructor(
		{ providerId, providerApiKey, firecrawlApiKey, modelId, breadth, depth }: ResearchTaskPayload["session"],
		clineProvider: ClineProvider,
	) {
		this.providerId = providerId
		this.providerApiKey = providerApiKey
		this.firecrawlApiKey = firecrawlApiKey
		this.modelId = modelId
		this.breadth = breadth
		this.depth = depth
		this.concurrency = 2

		this.providerRef = new WeakRef(clineProvider)

		this.firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey })

		if (providerId === "openai-native") {
			const openai = createOpenAI({ apiKey: providerApiKey })
			this.model = openai(modelId, { structuredOutputs: true })
		} else {
			const openrouter = createOpenRouter({ apiKey: providerApiKey })
			this.model = openrouter(modelId)
		}
	}

	/**
	 * Prompts.
	 */

	private researchSystemPrompt() {
		const now = new Date().toISOString()

		return trimPrompt(`
            You are an expert researcher. Today is ${now}. Follow these instructions when responding:
            - You may be asked to research subjects that is after your knowledge cutoff, assume the user is right when presented with news.
            - The user is a highly experienced analyst, no need to simplify it, be as detailed as possible and make sure your response is correct.
            - Be highly organized.
            - Suggest solutions that I didn't think about.
            - Be proactive and anticipate my needs.
            - Treat me as an expert in all subject matter.
            - Mistakes erode my trust, so be accurate and thorough.
            - Provide detailed explanations, I'm comfortable with lots of detail.
            - Value good arguments over authorities, the source is irrelevant.
            - Consider new technologies and contrarian ideas, not just the conventional wisdom.
            - You may use high levels of speculation or prediction, just flag it for me.
        `)
	}

	private chatSystemPrompt() {
		return trimPrompt(`
			You are an expert research assistant helping to explain and clarify research findings. Follow these guidelines:

			- You always answer the with markdown formatting. You will be penalized if you do not answer with markdown when it would be possible.
			- The markdown formatting you support: headings, bold, italic, links, tables, lists, code blocks, and blockquotes.
			- You do not support images and never include images. You will be penalized if you render images.
			- You also support Mermaid formatting. You will be penalized if you do not render Mermaid diagrams when it would be possible.
			- The Mermaid diagrams you support: sequenceDiagram, flowChart, classDiagram, stateDiagram, erDiagram, gantt, journey, gitGraph, pie.
			- Reference specific findings from the research when answering.
			- Be precise and detailed in explanations.
			- If asked about something outside the research scope, acknowledge this and stick to what was actually researched.
			- Feel free to make connections between different parts of the research.
			- When speculating or making inferences beyond the direct research, clearly label these as such.
			- If asked about sources, refer to the URLs provided in the research.
			- Maintain a professional, analytical tone.
			- Never include images in responses.
		`)

		// return trimPrompt(`
		// 	You are a general answering assistant that can comply with any request.

		// 	You always answer the with markdown formatting. You will be penalized if you do not answer with markdown when it would be possible.
		// 	The markdown formatting you support: headings, bold, italic, links, tables, lists, code blocks, and blockquotes.
		// 	You do not support images and never include images. You will be penalized if you render images.

		// 	You also support Mermaid formatting. You will be penalized if you do not render Mermaid diagrams when it would be possible.
		// 	The Mermaid diagrams you support: sequenceDiagram, flowChart, classDiagram, stateDiagram, erDiagram, gantt, journey, gitGraph, pie.
		// `)
	}

	/**
	 * LLM operations.
	 */

	public async generateFollowUps({ query, count = 1 }: { query: string; count?: number }) {
		const prompt = trimPrompt(`
            Given the following query from the user, ask some follow up questions to clarify the research direction.
            Return a maximum of ${count} questions, but feel free to return less if the original query is clear: <query>${query}</query>
        `)

		const schema = z.object({
			questions: z
				.array(z.string())
				.describe(`Follow up questions to clarify the research direction, max of ${count}`),
		})

		try {
			const {
				object: { questions },
			} = await this.withLoading(
				() => generateObject({ model: this.model, system: this.researchSystemPrompt(), prompt, schema }),
				"Clarifying...",
			)

			return questions.slice(0, count)
		} catch (error) {
			await this.postMessage({
				type: "research.error",
				text: error instanceof Error ? error.message : "Unknown error.",
			})

			this.abort()
			return []
		}
	}

	private async deepResearch({
		query,
		breadth,
		depth,
		learnings = [],
		visitedUrls = [],
		onProgressUpdated,
		onGeneratedQueries,
		onExtractedLearnings,
	}: ResearchStep): Promise<ResearchResult> {
		if (this.isAborted()) {
			return { learnings, visitedUrls }
		}

		const queries = await this.generateQueries({ query, learnings, breadth })
		onGeneratedQueries(queries)

		if (queries.length < breadth) {
			const delta = breadth - queries.length
			this.progress.expectedQueries = this.progress.expectedQueries - delta
			console.log(`[deepResearch] expectedQueries reduced by ${delta} to ${this.progress.expectedQueries}`)
			onProgressUpdated()
		}

		const limit = pLimit(this.concurrency)

		const results = await Promise.all(
			queries.map(({ query, researchGoal }) =>
				limit(async () => {
					if (this.isAborted()) {
						return { learnings, visitedUrls }
					}

					let result: SearchResponse

					try {
						result = await this.firecrawl.search(query, {
							timeout: 15000,
							limit: 5,
							scrapeOptions: { formats: ["markdown"] },
						})
					} catch (e) {
						const text = e instanceof Error ? e.message : "Unknown error"
						console.log(`[deepResearch] error = ${text}`)

						await this.postMessage({
							type: "research.error",
							text: `Encountered an error while crawling "${query}": ${text}`,
						})

						return { learnings, visitedUrls }
					}

					const newUrls = result.data.map(({ url }) => url).filter((url): url is string => url !== undefined)

					const newBreadth = Math.ceil(breadth / 2)
					const newDepth = depth - 1
					let newLearnings: ResearchLearnings

					try {
						newLearnings = await this.extractLearnings({ query, result, breadth: newBreadth })
					} catch (e) {
						const text = e instanceof Error ? e.message : "Unknown error"
						console.log(`[deepResearch] error = ${text}`)

						await this.postMessage({
							type: "research.error",
							text: `Encountered an error while extracting learnings from "${query}": ${text}`,
						})

						return { learnings, visitedUrls }
					}

					const allLearnings = [...learnings, ...newLearnings.learnings]
					const allUrls = [...visitedUrls, ...newUrls]
					onExtractedLearnings({ ...newLearnings, urls: newUrls })

					this.progress.completedQueries = this.progress.completedQueries + 1
					onProgressUpdated()

					if (newDepth <= 0) {
						return { learnings: allLearnings, visitedUrls: allUrls }
					}

					console.log(`[deepResearch] researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`)

					const nextQuery = trimPrompt(`
						Previous research goal: ${researchGoal}
						Follow-up research directions: ${newLearnings.followUpQuestions.map((q) => `\n${q}`).join("")}
					`)

					return this.deepResearch({
						query: nextQuery,
						breadth: newBreadth,
						depth: newDepth,
						learnings: allLearnings,
						visitedUrls: allUrls,
						onProgressUpdated,
						onGeneratedQueries,
						onExtractedLearnings,
					})
				}),
			),
		)

		return {
			learnings: [...new Set(results.flatMap((r) => r.learnings))],
			visitedUrls: [...new Set(results.flatMap((r) => r.visitedUrls))],
		}
	}

	private async generateReport({ learnings, visitedUrls }: { learnings: string[]; visitedUrls: string[] }) {
		const learningsString = truncatePrompt(
			learnings.map((learning) => `<learning>\n${learning}\n</learning>`).join("\n"),
			150_000,
		)

		const prompt = trimPrompt(`
			Given the following prompt from the user, write a final report on the topic using the learnings from research.
			Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:

			<prompt>${this.inquiry!.query}</prompt>

			Here are all the learnings from previous research:

			<learnings>
			${learningsString}
			</learnings>
		`)

		const schema = z.object({
			reportMarkdown: z.string().describe("Final report on the topic in Markdown"),
		})

		const {
			object: { reportMarkdown },
		} = await generateObject({ model: this.model, system: this.researchSystemPrompt(), prompt, schema })

		return reportMarkdown + `\n\n## Sources\n\n${visitedUrls.map((url) => `- ${url}`).join("\n")}`
	}

	/**
	 * Crawl operations.
	 */

	private async generateQueries({
		query,
		breadth,
		learnings,
	}: {
		query: string
		breadth: number
		learnings?: string[]
	}): Promise<ResearchQuery[]> {
		console.log(`[generateQueries] generating up to ${breadth} queries`)

		const prompt = trimPrompt(`
			Given the following prompt from the user, generate a list of SERP queries to research the topic.
			Return a maximum of ${breadth} queries, but feel free to return less if the original prompt is clear.
			Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>
		
			${learnings ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join("\n")}` : ""}
		`)

		const schema = z
			.object({
				queries: z.array(
					researchQuerySchema.extend({
						query: researchQuerySchema.shape.query.describe("The SERP query"),
						researchGoal: researchQuerySchema.shape.query.describe(
							"First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.",
						),
					}),
				),
			})
			.describe(`List of SERP queries, max of ${breadth}`)

		try {
			const {
				object: { queries },
			} = await generateObject({
				model: this.model,
				system: this.researchSystemPrompt(),
				prompt,
				schema,
			})

			console.log(`[generateQueries] generated ${queries.length} (out of ${breadth}) queries`, queries)

			return queries.slice(0, breadth)
		} catch (error) {
			await this.postMessage({
				type: "research.error",
				text: error instanceof Error ? error.message : "Unknown error.",
			})

			this.abort()
			return []
		}
	}

	private async extractLearnings({
		query,
		result,
		breadth,
		learningsCount = 3,
	}: {
		query: string
		result: SearchResponse
		breadth: number
		learningsCount?: number
	}): Promise<ResearchLearnings> {
		const contents = result.data
			.map((item) => item.markdown)
			.filter((content) => content !== undefined)
			.map((content) => truncatePrompt(content, 25_000))

		console.log(`[extractLearnings] extracting learings from  "${query}"`)

		const prompt = trimPrompt(`
			Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents.
			Return a maximum of ${learningsCount} learnings, but feel free to return less if the contents are clear.
			Make sure each learning is unique and not similar to each other.
			The learnings should be concise and to the point, as detailed and information dense as possible.
			Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates.
			The learnings will be used to research the topic further.

			<contents>${contents.map((content) => `<content>\n${content}\n</content>`).join("\n")}</contents>
		`)

		const schema = researchLearningsSchema.extend({
			learnings: researchLearningsSchema.shape.learnings.describe(
				`List of learnings from the contents, max of ${learningsCount}`,
			),
			followUpQuestions: researchLearningsSchema.shape.followUpQuestions.describe(
				`List of follow-up questions to research the topic further, max of ${breadth}`,
			),
		})

		try {
			const { object } = await generateObject({
				model: this.model,
				system: this.researchSystemPrompt(),
				prompt,
				schema,
				abortSignal: AbortSignal.timeout(60_000),
			})

			console.log(`[extractLearnings] extracted ${object.learnings.length} learnings`, object.learnings)

			return object
		} catch (error) {
			await this.postMessage({
				type: "research.error",
				text: error instanceof Error ? error.message : "Unknown error.",
			})

			this.abort()
			return { learnings: [], followUpQuestions: [] }
		}
	}

	/**
	 * State handlers.
	 *
	 * idle -> feedback -> research -> idle
	 */

	private async handleIdle(query: string) {
		this.status = "followUp"
		this.inquiry = { initialQuery: query, followUps: [], responses: [] }
		this.inquiry.followUps = await this.generateFollowUps({ query })
		await this.handleFollowUp(null)
	}

	private async handleFollowUp(content: string | null) {
		if (content) {
			this.inquiry.responses.push(content)
		}

		this.inquiry.responses.length >= this.inquiry.followUps.length
			? await this.transitionToResearch()
			: await this.postMessage({
					type: "research.output",
					text: JSON.stringify({
						content: this.inquiry.followUps[this.inquiry.responses.length],
						annotations: [
							{
								type: "badge",
								data: { label: "Follow Up", variant: "outline" },
							},
						],
					}),
				})
	}

	public async handleDone(message: { role: "user" | "assistant"; content: string }) {
		this.messages.push({ id: crypto.randomUUID(), ...message })

		const content = await this.withLoading(async () => {
			try {
				const { fullStream } = await streamText({
					model: this.model,
					system: this.chatSystemPrompt(),
					messages: this.messages,
				})

				let buffer = ""

				for await (const chunk of fullStream) {
					console.log("[handleDone] chunk =", chunk)

					switch (chunk.type) {
						case "text-delta":
							buffer += chunk.textDelta
							break
						case "error":
							const text = chunk.error instanceof Error ? chunk.error.message : "Unknown error."
							console.log(`[handleDone] error = ${text}`)
							await this.postMessage({ type: "research.error", text })
							return buffer
					}
				}

				return buffer
			} catch (error) {
				const text = error instanceof Error ? error.message : "Unknown error."
				console.log(`[handleDone] error = ${text}`)
				await this.postMessage({ type: "research.error", text })
				return undefined
			}
		})

		if (content) {
			await this.postMessage({
				type: "research.output",
				text: JSON.stringify({ content }),
			})
		}
	}

	/**
	 * State transitions.
	 */

	private async transitionToResearch() {
		this.status = "research"

		const query = trimPrompt(`
			Initial Query: ${this.inquiry.initialQuery}

			Follow-up Questions and Answers:
			${this.inquiry.followUps.map((followUp, index) => `Q: ${followUp}\nA: ${this.inquiry.responses[index]}`).join("\n\n")}
		`)

		this.inquiry.query = query

		const onProgressUpdated = () => {
			const { expectedQueries, completedQueries } = this.progress
			this.progress.progressPercentage = Math.round((completedQueries / expectedQueries) * 100)
			this.postMessage({ type: "research.progress", text: JSON.stringify(this.progress) })
		}

		const onGeneratedQueries = (queries: ResearchQuery[]) =>
			this.postMessage({
				type: "research.output",
				text: JSON.stringify({
					content: `Generated ${queries.length} topics to research.\n\n${queries.map(({ query }) => `- ${query}`).join("\n")}`,
					annotations: [
						{
							type: "badge",
							data: { label: "Idea", variant: "outline" },
						},
					],
				}),
			})

		const onExtractedLearnings = (learnings: ResearchLearnings & { urls: string[] }) =>
			this.postMessage({
				type: "research.output",
				text: JSON.stringify({
					content: `Extracted ${learnings.learnings.length} learnings from ${learnings.urls.length} sources.\n\n${learnings.urls.map((url) => `- ${url}`).join("\n")}`,
					annotations: [
						{
							type: "badge",
							data: { label: "Learning", variant: "outline" },
						},
					],
				}),
			})

		this.progress.expectedQueries = getTreeSize({ breadth: this.breadth, depth: this.depth })
		onProgressUpdated()

		console.log(`[transitionToResearch] query = ${query}`)
		console.log(`[transitionToResearch] breadth = ${this.breadth}`)
		console.log(`[transitionToResearch] depth = ${this.depth}`)
		console.log(`[transitionToResearch] expectedQueries = ${this.progress.expectedQueries}`)

		const { learnings, visitedUrls } = await this.withLoading(
			() =>
				this.deepResearch({
					query,
					breadth: this.breadth,
					depth: this.depth,
					learnings: [],
					visitedUrls: [],
					onProgressUpdated,
					onGeneratedQueries,
					onExtractedLearnings,
				}),
			"Researching...",
		)

		if (this.isAborted()) {
			return
		}

		this.inquiry.learnings = learnings
		this.inquiry.urls = visitedUrls

		const report = await this.withLoading(() => this.generateReport({ learnings, visitedUrls }), "Summarizing...")
		this.inquiry.report = report

		await this.postMessage({
			type: "research.output",
			text: JSON.stringify({
				content: report,
				annotations: [{ type: "badge", data: { label: "Completed", variant: "default" } }],
			}),
		})

		this.transitionToDone()
	}

	private async transitionToDone() {
		this.status = "done"

		this.messages.push({
			id: crypto.randomUUID(),
			role: "system",
			content: trimPrompt(`
				Here is the complete research context:
				${this.inquiry.query}

				Research Process:
				- Depth: ${this.depth}
				- Breadth: ${this.breadth}

				Intermediate Research Learnings:
				${this.inquiry.learnings?.map((learning) => `- ${learning}`).join("\n")}

				URLs Visited:
				${this.inquiry.urls?.map((url) => `- ${url}`).join("\n")}

				Final Research Report:
				${this.inquiry.report}
			`),
		})

		const content = "I'm available to answer any questions you might have about the detailed report above."
		this.messages.push({ id: crypto.randomUUID(), role: "assistant", content })

		await this.postMessage({
			type: "research.output",
			text: JSON.stringify({
				content,
				annotations: [{ type: "badge", data: { label: "👋", variant: "outline" } }],
			}),
		})
	}

	/**
	 * Event handlers.
	 */

	public async append(content: string) {
		if (this.isAborted()) {
			this.postMessage({ type: "research.error", text: "Deep research task has ended." })
			return
		}

		// return await this.handleDone({ role: "assistant", content })

		const stateHandlers = {
			idle: () => this.handleIdle(content),
			followUp: () => this.handleFollowUp(content),
			research: () => console.log("NOOP", content),
			done: () => this.handleDone({ role: "assistant", content }),
			aborted: () => console.log("NOOP", content),
		} as const

		console.log(`[DeepResearchService#append] executing ${this.status} handler with content = "${content}"`)
		await stateHandlers[this.status]()
	}

	/**
	 * Statuses.
	 */

	public abort() {
		console.log("[abort] aborting")
		this.status = "aborted"
	}

	public isAborted() {
		return this.status === "aborted"
	}

	private get status(): "idle" | "followUp" | "research" | "done" | "aborted" {
		return this._status
	}

	private set status(value: "idle" | "followUp" | "research" | "done" | "aborted") {
		if (this.isAborted()) {
			return
		}

		console.log(`[setStatus] ${this.status} -> ${value}`)
		this.postMessage({ type: "research.status", text: JSON.stringify({ status: value }) })
		this._status = value
	}

	/**
	 * Helpers.
	 */

	private async withLoading<T>(operation: () => Promise<T>, message?: string): Promise<T> {
		await this.postMessage({ type: "research.loading", text: JSON.stringify({ message, isLoading: true }) })

		try {
			return await operation()
		} finally {
			await this.postMessage({ type: "research.loading", text: JSON.stringify({ message, isLoading: false }) })
		}
	}

	private postMessage(message: ExtensionMessage) {
		if (this.isAborted() && message.type === "research.output") {
			return
		}

		this.providerRef.deref()?.postMessageToWebview(message)
	}
}
