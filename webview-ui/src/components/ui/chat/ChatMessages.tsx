import { useEffect, useRef } from "react"
import { Loader2 } from "lucide-react"
import { StopIcon, ReloadIcon } from "@radix-ui/react-icons"

import { Button } from "@/components/ui"

import { useChatUI } from "./useChatUI"
import { useChatMessages } from "./useChatMessages"
import { ChatMessage } from "./ChatMessage"

/**
 * ChatMessages
 */

export function ChatMessages() {
	const { messages, isLoading, loadingMessage, append } = useChatUI()
	const { lastMessage, messageCount } = useChatMessages()

	const scrollableChatContainerRef = useRef<HTMLDivElement>(null)

	const scrollToBottom = () => {
		if (scrollableChatContainerRef.current) {
			// Make the scrolling behavior more reliable when multiple messages
			// arrive quickly.

			// First scroll immediately to cancel any ongoing smooth scroll.
			scrollableChatContainerRef.current.scrollTo({
				top: scrollableChatContainerRef.current.scrollHeight,
				behavior: "auto",
			})

			// Then trigger the smooth scroll.
			requestAnimationFrame(() => {
				scrollableChatContainerRef.current?.scrollTo({
					top: scrollableChatContainerRef.current.scrollHeight,
					behavior: "smooth",
				})
			})
		}
	}

	useEffect(() => {
		scrollToBottom()
	}, [messageCount, lastMessage])

	useEffect(() => {
		if (isLoading) {
			scrollToBottom()
		}
	}, [isLoading])

	return (
		<div className="flex flex-col flex-1 min-h-0 overflow-auto" ref={scrollableChatContainerRef}>
			{messages.map((message, index) => (
				<ChatMessage
					key={index}
					message={message}
					isHeaderVisible={
						!!message.annotations?.length || index === 0 || messages[index - 1].role !== message.role
					}
					isLast={index === messageCount - 1}
					isLoading={isLoading}
					append={append}
				/>
			))}
			{isLoading && <ChatMessagesLoading message={loadingMessage} />}
		</div>
	)
}

/**
 * ChatMessagesLoading
 */

type ChatMessagesLoadingProps = {
	message?: string
}

function ChatMessagesLoading({ message }: ChatMessagesLoadingProps) {
	return (
		<div className="flex items-center justify-center py-4">
			<Loader2 className="h-4 w-4 animate-spin" />
			{message && <div className="ml-2 text-sm text-muted-foreground">{message}</div>}
		</div>
	)
}

/**
 * ChatActions
 */

export function ChatActions() {
	const { reload, stop, requestData } = useChatUI()
	const { showReload, showStop } = useChatMessages()

	return (
		<div className="flex flex-row justify-center pt-2 border-t border-vscode-editor-background">
			{showStop && (
				<Button variant="ghost" size="sm" onClick={stop}>
					<StopIcon className="text-destructive" />
				</Button>
			)}
			{showReload && (
				<Button variant="ghost" size="sm" onClick={() => reload?.({ data: requestData })}>
					<ReloadIcon />
				</Button>
			)}
		</div>
	)
}
