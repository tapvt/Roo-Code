import { useState, useCallback, useRef } from "react"
import { useEvent, useMount } from "react-use"
import { Cross2Icon, ReaderIcon, RocketIcon } from "@radix-ui/react-icons"

import { ExtensionMessage } from "../../../../src/shared/ExtensionMessage"

import { Button, Progress } from "@/components/ui"
import { Chat, MessageAnnotation, MessageAnnotationType } from "@/components/ui/chat"

import {
	loadingSchema,
	outputSchema,
	ResearchProgress,
	researchProgressSchema,
	ResearchStatus,
	researchStatusSchema,
} from "./types"
import { useDeepResearch } from "./useDeepResearch"
import { useSession } from "./useSession"

export const Session = () => {
	const { session, setSession } = useSession()
	const handler = useDeepResearch()
	const { setIsLoading, setLoadingMessage, start, append, reset, viewReport, createTask } = handler
	const initialized = useRef(false)
	const [progress, setProgress] = useState<ResearchProgress>()
	const [status, setStatus] = useState<ResearchStatus["status"]>()

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
					} else {
						console.warn(`[DeepResearch#onMessage] Invalid ${type}: ${text}: ${result.error}`)
					}

					break
				case "research.output": {
					const result = outputSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						const { content, annotations } = result.data
						append({
							role: "assistant",
							content,
							annotations: annotations as MessageAnnotation[],
						})
					} else {
						console.warn(`[DeepResearch#onMessage] Invalid ${type}: ${text}: ${result.error}`)
					}

					break
				}
				case "research.progress": {
					const result = researchProgressSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						setProgress(result.data)
					} else {
						console.warn(`[DeepResearch#onMessage] Invalid ${type}: ${text}: ${result.error}`)
					}

					break
				}
				case "research.status": {
					const result = researchStatusSchema.safeParse(JSON.parse(text ?? "{}"))

					if (result.success) {
						const { status } = result.data
						setStatus(status)
					} else {
						console.warn(`[DeepResearch#onMessage] Invalid ${type}: ${text}: ${result.error}`)
					}

					break
				}
				case "research.error":
					if (text) {
						append({
							role: "assistant",
							content: text,
							annotations: [
								{
									type: MessageAnnotationType.BADGE,
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
				{status === "aborted" ? (
					<div className="flex flex-row items-center justify-between gap-2 border-t border-vscode-editor-background p-4">
						<div className="text-destructive">Deep research task canceled.</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setSession(undefined)
								reset?.()
							}}>
							Done
						</Button>
					</div>
				) : status === "research" && progress && progress.progressPercentage < 100 ? (
					<div className="border-t border-vscode-editor-background p-4">
						<Progress value={Math.max(progress.progressPercentage, 5)} />
					</div>
				) : status === "done" ? (
					<div className="flex flex-row items-center justify-end gap-2 border-t border-vscode-editor-background p-4">
						<Button variant="outline" size="sm" onClick={viewReport}>
							<ReaderIcon />
							View Report
						</Button>
						<Button variant="default" size="sm" onClick={createTask}>
							<RocketIcon />
							Create Task
						</Button>
					</div>
				) : null}
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
