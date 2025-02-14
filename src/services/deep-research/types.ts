import { z } from "zod"

export interface ResearchInquiry {
	initialQuery?: string
	followUps: string[]
	responses: string[]
	query?: string
	learnings?: string[]
	urls?: string[]
	report?: string
}

export type ResearchStep = {
	query: string
	breadth: number
	depth: number
	learnings?: string[]
	visitedUrls?: string[]
	onProgress: (progress: ResearchProgress) => void
	onNewLearnings: (learnings: ResearchLearnings & { urls: string[] }) => void
}

export type ResearchProgress = {
	currentDepth: number
	totalDepth: number
	currentBreadth: number
	totalBreadth: number
	currentQuery?: string
	totalQueries: number
	completedQueries: number
	progressPercentage: number
}

export type ResearchResult = {
	learnings: string[]
	visitedUrls: string[]
}

export const researchLearningsSchema = z.object({
	learnings: z.array(z.string()),
	followUpQuestions: z.array(z.string()),
})

export type ResearchLearnings = z.infer<typeof researchLearningsSchema>
