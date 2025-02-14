import { cn } from "@/lib/utils"

import { useSession } from "./useSession"
import { GetStarted } from "./GetStarted"
import { History } from "./History"
import { Session } from "./Session"

type DeepResearchProps = {
	isHidden: boolean
	onDone: () => void
}

export const DeepResearch = ({ isHidden }: DeepResearchProps) => {
	const { session } = useSession()

	if (session) {
		return (
			<div className={cn("fixed inset-0 flex flex-col", { hidden: isHidden })}>
				<Session />
			</div>
		)
	}

	return (
		<div
			className={cn("lex flex-col items-center justify-center h-full gap-4 overflow-y-auto py-4", {
				hidden: isHidden,
			})}>
			<GetStarted />
			<History />
		</div>
	)
}
