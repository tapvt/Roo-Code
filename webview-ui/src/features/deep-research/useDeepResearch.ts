import { useCallback, useState } from "react"

import { vscode } from "@/utils/vscode"

import { ChatHandler, Message } from "@/components/ui/chat"
import { Session } from "./types"

type UseDeepResearch = ChatHandler & {
	viewReport: () => void
	createTask: () => void
}

export const useDeepResearch = (): UseDeepResearch => {
	const [isLoading, setIsLoading] = useState(false)
	const [loadingMessage, setLoadingMessage] = useState<string | undefined>(undefined)
	const [input, setInput] = useState("")
	const [messages, setMessages] = useState<Message[]>([])

	const start = (options?: { data?: Session }) => {
		if (options?.data) {
			const session = options.data
			vscode.postMessage({ type: "research.task", payload: { session } })
			const message: Message = { role: "user", content: session.query }
			setMessages((prev) => [...prev, message])
		}
	}

	const stop = () => {
		vscode.postMessage({ type: "research.abort" })
	}

	const append = async (message: Message, options?: { data?: any }) => {
		if (message.role === "user") {
			vscode.postMessage({ type: "research.input", payload: { message, chatRequestOptions: options } })
		}

		setMessages((prev) => [...prev, message])
		return Promise.resolve(null)
	}

	const reset = () => {
		setIsLoading(false)
		setInput("")
		setMessages([])
		vscode.postMessage({ type: "research.reset" })
	}

	const viewReport = useCallback(() => {
		vscode.postMessage({ type: "research.viewReport" })
	}, [])

	const createTask = useCallback(() => {
		vscode.postMessage({ type: "research.createTask" })
	}, [])

	return {
		isLoading,
		setIsLoading,
		loadingMessage,
		setLoadingMessage,
		input,
		setInput,
		messages,
		start,
		stop,
		append,
		reset,
		viewReport,
		createTask,
	}
}
