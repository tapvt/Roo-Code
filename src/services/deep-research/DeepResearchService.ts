import { createOpenAI } from "@ai-sdk/openai"
import FirecrawlApp, { SearchResponse } from "@mendable/firecrawl-js"
import { generateObject, LanguageModel, Message, streamText } from "ai"
import { z } from "zod"
import pLimit from "p-limit"

import { ExtensionMessage } from "../../shared/ExtensionMessage"
import { ClineProvider } from "../../core/webview/ClineProvider"

import { ResearchInquiry, ResearchStep, ResearchProgress, ResearchResult, researchLearningsSchema } from "./types"
import { truncatePrompt, trimPrompt } from "./utils/prompt"

export class DeepResearchService {
	private providerRef: WeakRef<ClineProvider>
	private firecrawl: FirecrawlApp
	private model: LanguageModel
	private status: "idle" | "followUp" | "research" | "done" = "idle"

	private inquiry: ResearchInquiry = { followUps: [], responses: [] }
	private messages: Message[] = []

	constructor(
		clineProvider: ClineProvider,
		public readonly modelId: string,
		public readonly breadth: number,
		public readonly depth: number,
		public readonly concurrency: number,
		public readonly firecrawlApiKey: string,
		public readonly openaiApiKey: string,
	) {
		this.providerRef = new WeakRef(clineProvider)

		this.firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey })

		this.model = createOpenAI({ apiKey: openaiApiKey })(modelId, {
			// reasoningEffort: "medium",
			structuredOutputs: true,
		})
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

	// You are a general answering assistant that can comply with any request.

	// You always answer the with markdown formatting. You will be penalized if you do not answer with markdown when it would be possible.
	// The markdown formatting you support: headings, bold, italic, links, tables, lists, code blocks, and blockquotes.
	// You do not support images and never include images. You will be penalized if you render images.

	// You also support Mermaid formatting. You will be penalized if you do not render Mermaid diagrams when it would be possible.
	// The Mermaid diagrams you support: sequenceDiagram, flowChart, classDiagram, stateDiagram, erDiagram, gantt, journey, gitGraph, pie.

	private chatSystemPrompt() {
		return trimPrompt(`
            You are an expert research assistant helping to explain and clarify research findings. Follow these guidelines:

            - Use markdown formatting for all responses including: headings, bold, italic, links, tables, lists, code blocks, and blockquotes
            - Support Mermaid diagrams when appropriate (sequenceDiagram, flowChart, classDiagram, stateDiagram, erDiagram, gantt, journey, gitGraph, pie)
            - Reference specific findings from the research when answering
            - Be precise and detailed in explanations
            - If asked about something outside the research scope, acknowledge this and stick to what was actually researched
            - Feel free to make connections between different parts of the research
            - When speculating or making inferences beyond the direct research, clearly label these as such
            - If asked about sources, refer to the URLs provided in the research
            - Maintain a professional, analytical tone
            - Never include images in responses
        `)
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

		const {
			object: { questions },
		} = await this.withLoading(
			() => generateObject({ model: this.model, system: this.researchSystemPrompt(), prompt, schema }),
			"Clarifying...",
		)

		return questions.slice(0, count)
	}

	private async deepResearch({
		query,
		breadth,
		depth,
		learnings = [],
		visitedUrls = [],
		onProgress,
		onNewLearnings,
	}: ResearchStep): Promise<ResearchResult> {
		let progress: ResearchProgress = {
			currentDepth: depth,
			totalDepth: depth,
			currentBreadth: breadth,
			totalBreadth: breadth,
			totalQueries: 0,
			completedQueries: 0,
			progressPercentage: 0,
		}

		const reportProgress = (update: Partial<ResearchProgress>) => {
			progress = {
				...progress,
				...update,
			}

			// Calculate total work across all depth levels.
			let totalWork = 0
			let currentWork = 0

			// Calculate work for each depth level.
			for (let d = progress.totalDepth; d > 0; d--) {
				// Calculate breadth at this depth level.
				const breadthAtLevel = Math.ceil(progress.totalBreadth / Math.pow(2, progress.totalDepth - d))
				totalWork += breadthAtLevel

				// Add completed work for this level.
				if (d > progress.currentDepth) {
					// Past levels are complete.
					currentWork += breadthAtLevel
				} else if (d === progress.currentDepth) {
					// Current level - add completed queries.
					currentWork += progress.completedQueries
				}

				// Future levels aren't counted yet.
			}

			progress.progressPercentage = Math.round((currentWork / totalWork) * 100)
			onProgress(progress)
		}

		const queries = await this.generateQueries({
			query,
			learnings,
			numQueries: breadth,
		})

		reportProgress({ currentQuery: queries[0]?.query, totalQueries: queries.length })

		const limit = pLimit(this.concurrency)

		const results = await Promise.all(
			queries.map(({ query, researchGoal }) =>
				limit(async () => {
					try {
						const result = await this.firecrawl.search(query, {
							timeout: 15000,
							limit: 5,
							scrapeOptions: { formats: ["markdown"] },
						})

						const newUrls = result.data
							.map(({ url }) => url)
							.filter((url): url is string => url !== undefined)

						const newBreadth = Math.ceil(breadth / 2)
						const newDepth = depth - 1

						const newLearnings = await this.processLearnings({
							query,
							result,
							numFollowUpQuestions: newBreadth,
						})

						onNewLearnings({ ...newLearnings, urls: newUrls })

						const allLearnings = [...learnings, ...newLearnings.learnings]
						const allUrls = [...visitedUrls, ...newUrls]

						if (newDepth > 0) {
							console.log(`Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`)

							reportProgress({
								currentDepth: newDepth,
								currentBreadth: newBreadth,
								completedQueries: progress.completedQueries + 1,
								currentQuery: query,
							})

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
								onProgress,
								onNewLearnings,
							})
						} else {
							reportProgress({
								currentDepth: 0,
								completedQueries: progress.completedQueries + 1,
								currentQuery: query,
							})

							return { learnings: allLearnings, visitedUrls: allUrls }
						}
					} catch (e: any) {
						if (e.message && e.message.includes("Timeout")) {
							console.log(`Timeout error running query: ${query}: `, e)
						} else {
							console.log(`Error running query: ${query}: `, e)
						}

						return { learnings: [], visitedUrls: [] }
					}
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
		numQueries = 3,
		learnings,
	}: {
		query: string
		numQueries?: number
		learnings?: string[] // Optional, if provided, the research will continue from the last learning.
	}) {
		const prompt = `
			Given the following prompt from the user, generate a list of SERP queries to research the topic.
			Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear.
			Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>
		
			${learnings ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join("\n")}` : ""}
		`

		const schema = z.object({
			queries: z
				.array(
					z.object({
						query: z.string().describe("The SERP query"),
						researchGoal: z
							.string()
							.describe(
								"First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.",
							),
					}),
				)
				.describe(`List of SERP queries, max of ${numQueries}`),
		})

		const {
			object: { queries },
		} = await generateObject({ model: this.model, system: this.researchSystemPrompt(), prompt, schema })

		console.log(`[generateQueries] generated ${queries.length} queries`, queries)

		return queries.slice(0, numQueries)
	}

	private async processLearnings({
		query,
		result,
		numLearnings = 3,
		numFollowUpQuestions = 3,
	}: {
		query: string
		result: SearchResponse
		numLearnings?: number
		numFollowUpQuestions?: number
	}) {
		const contents = result.data
			.map((item) => item.markdown)
			.filter((content) => content !== undefined)
			.map((content) => truncatePrompt(content, 25_000))

		console.log(`[processLearnings] ran ${query}, found ${contents.length} contents`)

		const prompt = trimPrompt(`
			Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents.
			Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear.
			Make sure each learning is unique and not similar to each other.
			The learnings should be concise and to the point, as detailed and information dense as possible.
			Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates.
			The learnings will be used to research the topic further.
	
			<contents>${contents.map((content) => `<content>\n${content}\n</content>`).join("\n")}</contents>
		`)

		const schema = researchLearningsSchema.extend({
			learnings: researchLearningsSchema.shape.learnings.describe(
				`List of learnings from the contents, max of ${numLearnings}`,
			),
			followUpQuestions: researchLearningsSchema.shape.followUpQuestions.describe(
				`List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
			),
		})

		const { object } = await generateObject({
			model: this.model,
			system: this.researchSystemPrompt(),
			prompt,
			schema,
			abortSignal: AbortSignal.timeout(60_000),
		})

		console.log(`[processLearnings] created ${object.learnings.length} learnings`, object.learnings)

		return object
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

		this.inquiry.responses.length >= this.inquiry.followUps.length
			? await this.transitionToResearch()
			: await this.postMessage({
					type: "research.followUp",
					text: this.inquiry.followUps[this.inquiry.responses.length],
				})
	}

	private async handleFollowUp(content: string) {
		this.inquiry.responses.push(content)

		this.inquiry.responses.length >= this.inquiry.followUps.length
			? await this.transitionToResearch()
			: await this.postMessage({
					type: "research.followUp",
					text: this.inquiry.followUps[this.inquiry.responses.length],
				})
	}

	public async handleDone(message: { role: "user" | "assistant"; content: string }) {
		this.messages.push({ id: crypto.randomUUID(), ...message })

		const text = await this.withLoading(async () => {
			const { fullStream } = await streamText({
				model: this.model,
				system: this.chatSystemPrompt(),
				messages: this.messages,
			})

			let buffer = ""

			for await (const chunk of fullStream) {
				buffer += chunk.type === "text-delta" ? chunk.textDelta : ""
			}

			return buffer
		})

		await this.postMessage({ type: "research.output", text })
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

		const { learnings, visitedUrls } = await this.withLoading(
			() =>
				this.deepResearch({
					query,
					breadth: this.breadth,
					depth: this.depth,
					learnings: [],
					visitedUrls: [],
					onProgress: (progress) =>
						this.postMessage({ type: "research.progress", text: JSON.stringify(progress) }),
					onNewLearnings: (learnings) =>
						this.postMessage({ type: "research.learnings", text: JSON.stringify(learnings) }),
				}),
			"Researching...",
		)

		this.inquiry.learnings = learnings
		this.inquiry.urls = visitedUrls

		const report = await this.withLoading(() => this.generateReport({ learnings, visitedUrls }), "Summarizing...")
		this.inquiry.report = report
		await this.postMessage({ type: "research.result", text: report })

		this.transitionToDone()
	}

	// TODO: Write the history to a file.
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
		await this.postMessage({ type: "research.output", text: content })
	}

	/**
	 * Event handlers.
	 */

	public async append(content: string) {
		console.log("[DeepResearchService#append] content =", content)

		const stateHandlers = {
			idle: () => this.handleIdle(content),
			followUp: () => this.handleFollowUp(content),
			research: () => console.log("NOOP", content),
			done: () => this.handleDone({ role: "assistant", content }),
		} as const

		await stateHandlers[this.status]()
	}

	public async abort() {
		console.log("abort")
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
		this.providerRef.deref()?.postMessageToWebview(message)
	}
}
