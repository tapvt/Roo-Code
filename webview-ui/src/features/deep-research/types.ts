import { z } from "zod"

import { MessageAnnotationType } from "@/components/ui/chat"

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

export const researchProgressSchema = z.object({
	completedQueries: z.number().min(0),
	expectedQueries: z.number().min(0),
	progressPercentage: z.number().min(0).max(100),
})

export type ResearchProgress = z.infer<typeof researchProgressSchema>

export const outputSchema = z.object({
	content: z.string().min(1),
	annotations: z
		.array(
			z.object({
				type: z.nativeEnum(MessageAnnotationType),
				data: z.unknown(),
			}),
		)
		.optional(),
})

export type Output = z.infer<typeof outputSchema>

export const researchStatusSchema = z.object({
	status: z.enum(["idle", "followUp", "research", "done", "aborted"]),
})

export type ResearchStatus = z.infer<typeof researchStatusSchema>
