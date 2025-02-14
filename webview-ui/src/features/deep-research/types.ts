import { z } from "zod"

export const sessionSchema = z.object({
	modelId: z.string().min(1),
	breadth: z.number().min(1).max(10),
	depth: z.number().min(1).max(10),
	query: z.string().min(1),
	firecrawlApiKey: z.string().min(1),
	openaiApiKey: z.string().min(1),
})

export type Session = z.infer<typeof sessionSchema>

export const loadingSchema = z.object({
	message: z.string().optional(),
	isLoading: z.boolean(),
})

export type Loading = z.infer<typeof loadingSchema>

export const progressSchema = z.object({
	currentQuery: z.string().optional(),
	completedQueries: z.number().min(0),
	totalQueries: z.number().min(0),
	currentDepth: z.number().min(0),
	totalDepth: z.number().min(0),
	currentBreadth: z.number().min(0),
	totalBreadth: z.number().min(0),
	progressPercentage: z.number().min(0).max(100),
})

export type Progress = z.infer<typeof progressSchema>

export const learningsSchema = z.object({
	learnings: z.array(z.string()),
	followUpQuestions: z.array(z.string()),
	urls: z.array(z.string()),
})

export type Learnings = z.infer<typeof learningsSchema>
