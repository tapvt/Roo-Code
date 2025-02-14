import { useState, useCallback, useRef } from "react"
import { useEvent, useMount } from "react-use"
import { Cross2Icon } from "@radix-ui/react-icons"

import { ExtensionMessage } from "../../../../src/shared/ExtensionMessage"

import { Button } from "@/components/ui"
import { Chat, MessageAnnotationType } from "@/components/ui/chat"

import { learningsSchema, loadingSchema, Progress, progressSchema } from "./types"
import { useDeepResearch } from "./useDeepResearch"
import { useSession } from "./useSession"

export const Session = () => {
	const { session, setSession } = useSession()
	const handler = useDeepResearch()
	const { setIsLoading, setLoadingMessage, start, append, reset } = handler
	const initialized = useRef(false)
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [_progress, setProgress] = useState<Progress>()
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [_isResearching, setIsResearching] = useState(false)

	const onMessage = useCallback(
		({ data: { type, text } }: MessageEvent<ExtensionMessage>) => {
			console.log(`[DeepResearch#onMessage] ${type} -> ${text}`)

			switch (type) {
				case "research.loading":
					const result = loadingSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						const { isLoading, message } = result.data
						setIsLoading(isLoading)
						setLoadingMessage?.(message ?? "")
					}

					break
				case "research.output":
				case "research.followUp": {
					if (text) {
						append({ role: "assistant", content: text })
					}

					break
				}
				case "research.progress": {
					setIsResearching(true)
					const result = progressSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						setProgress(result.data)

						if (result.data.currentQuery) {
							append({
								role: "assistant",
								content: result.data.currentQuery,
								annotations: [
									{
										type: MessageAnnotationType.BADGES,
										data: {
											label: "Researching Topic",
											variant: "outline",
										},
									},
								],
							})
						}
					}

					break
				}
				case "research.learnings": {
					const result = learningsSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						const { learnings, urls } = result.data

						append({
							role: "assistant",
							content: `Generated ${learnings.length} learnings from ${urls.length} sources.\n\n${urls.map((url) => `- ${url}`).join("\n")}`,
							annotations: [
								{
									type: MessageAnnotationType.BADGES,
									data: {
										label: "Learning Acquired",
										variant: "outline",
									},
								},
							],
						})
					}

					break
				}
				case "research.result":
					setIsResearching(false)

					if (text) {
						append({
							role: "assistant",
							content: text,
							annotations: [
								{
									type: MessageAnnotationType.BADGES,
									data: {
										label: "Report",
										variant: "outline",
									},
								},
							],
						})
					}

					break
				case "research.error":
					setIsResearching(false)

					if (text) {
						append({
							role: "assistant",
							content: text,
							annotations: [
								{
									type: MessageAnnotationType.BADGES,
									data: {
										label: "Error",
										variant: "destructive",
									},
								},
							],
						})
					}

					break
			}
		},
		[setIsLoading, setLoadingMessage, append],
	)

	useEvent("message", onMessage)

	useMount(() => {
		if (session && !initialized.current) {
			start?.({ data: session })
			initialized.current = true
		}
	})

	if (!session) {
		return null
	}

	return (
		<>
			<Chat handler={handler} className="pt-10 pr-[1px]">
				{/* {isResearching && progress && (
					<div className="flex flex-row justify-center gap-4 p-2 border-t border-vscode-editor-background">
						<div>
							<span className="text-muted-foreground">Query</span> {progress.completedQueries} /{" "}
							{progress.totalQueries}
						</div>
						<div>
							<span className="text-muted-foreground">Breadth</span> {progress.currentBreadth} /{" "}
							{progress.totalBreadth}
						</div>
						<div>
							<span className="text-muted-foreground">Depth</span> {progress.currentDepth} /{" "}
							{progress.totalDepth}
						</div>
						<div>
							<span className="text-muted-foreground">Progress</span> {progress.progressPercentage}%
						</div>
					</div>
				)} */}
			</Chat>
			<div className="absolute top-0 left-0 h-10 flex flex-row items-center justify-between gap-2 w-full pl-3 pr-1">
				<div className="flex-1 truncate text-sm text-muted-foreground">{session.query}</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => {
						setSession(undefined)
						reset?.()
					}}>
					<Cross2Icon />
				</Button>
			</div>
		</>
	)
}
