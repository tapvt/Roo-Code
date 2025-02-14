import { useCallback, useEffect } from "react"
import { useForm, FormProvider, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { BrainCircuit } from "lucide-react"

import { Button, Slider, AutosizeTextarea, Input } from "@/components/ui"

import { useSession } from "./useSession"
import { useProvider } from "./useProvider"
import { Session, sessionSchema } from "./types"
import { Providers } from "./Providers"
import { Models } from "./Models"

export const GetStarted = () => {
	const { setSession } = useSession()
	const { provider, setProviderValue } = useProvider()

	const form = useForm<Session>({
		resolver: zodResolver(sessionSchema),
		defaultValues: {
			providerId: provider?.providerId ?? "",
			modelId: "o3-mini",
			providerApiKey: provider?.providerApiKey ?? "",
			firecrawlApiKey: provider?.firecrawlApiKey ?? "",
			breadth: 4,
			depth: 2,
			query: "",
		},
	})

	const {
		handleSubmit,
		control,
		setValue,
		formState: { errors },
	} = form

	const onSubmit = useCallback(
		(data: Session) => {
			// This is the only value we care to persist for now.
			setProviderValue("firecrawlApiKey", data.firecrawlApiKey)
			setSession(data)
		},
		[setSession, setProviderValue],
	)

	useEffect(() => {
		if (provider) {
			setValue("providerId", provider.providerId ?? "")
			setValue("providerApiKey", provider.providerApiKey ?? "")
			setValue("firecrawlApiKey", provider.firecrawlApiKey ?? "")
		}
	}, [provider, setValue])

	return (
		<div className="flex flex-col gap-4 w-full max-w-sm p-4">
			<div className="flex flex-col items-center justify-center gap-2">
				<div className="flex flex-row items-center justify-center gap-2">
					<BrainCircuit className="text-muted" />
					<h2 className="my-0">Open Deep Research</h2>
				</div>
				<h3 className="my-0">
					The ultimate <span className="text-vscode-focusBorder">planner</span>.
				</h3>
			</div>
			<div className="flex flex-col gap-2 bg-vscode-editor-background p-4 rounded-sm">
				<div>Get detailed insights on any topic by synthesizing large amounts of online information.</div>
				<div>
					Complete multi-step research tasks that can be fed into a Roo Code task to super-charge its problem
					solving abilities.
				</div>
			</div>
			<FormProvider {...form}>
				<form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
					<div className="flex flex-col gap-1">
						<div>Configuration Profile</div>
						<Providers />
						<div className="text-muted-foreground">
							Only profiles using the OpenRouter and OpenAI providers are currently supported.
						</div>
					</div>
					{provider && (
						<>
							<div className="flex flex-col gap-1">
								<div>{provider.providerName} Model</div>
								<Models />
							</div>
							<Controller
								name="providerApiKey"
								control={control}
								render={({ field }) => (
									<div className="xflex flex-col gap-1 hidden">
										{provider ? <div>{provider.providerName} API Key</div> : <div>API Key</div>}
										<Input {...field} type="password" placeholder="sk-..." className="flex-1" />
									</div>
								)}
							/>
							<Controller
								name="firecrawlApiKey"
								control={control}
								render={({ field }) => (
									<div className="flex flex-col gap-1">
										<div>Firecrawl API Key</div>
										<Input {...field} type="password" placeholder="fc-..." className="flex-1" />
									</div>
								)}
							/>
						</>
					)}
					<Controller
						name="breadth"
						control={control}
						render={({ field: { value, onChange } }) => (
							<div className="flex flex-row items-center gap-2">
								<div className="w-20 whitespace-nowrap shrink-0">
									Breadth <span className="text-muted-foreground">({value})</span>
								</div>
								<Slider
									min={1}
									max={10}
									step={1}
									value={[value]}
									onValueChange={(values) => onChange(values[0])}
								/>
							</div>
						)}
					/>
					<Controller
						name="depth"
						control={control}
						render={({ field: { value, onChange } }) => (
							<div className="flex flex-row items-center gap-2">
								<div className="w-20 whitespace-nowrap shrink-0">
									Depth <span className="text-muted-foreground">({value})</span>
								</div>
								<Slider
									min={1}
									max={10}
									step={1}
									value={[value]}
									onValueChange={(values) => onChange(values[0])}
								/>
							</div>
						)}
					/>
					<Controller
						name="query"
						control={control}
						render={({ field }) => (
							<AutosizeTextarea
								{...field}
								placeholder="What would you like me to research?"
								minHeight={75}
								maxHeight={200}
								className="p-3"
							/>
						)}
					/>
					<Button type="submit">Start Researching</Button>
					<div className="flex flex-col gap-1">
						{Object.entries(errors).map(([field, error]) => (
							<div key={field} className="text-red-500">
								{error?.message}
							</div>
						))}
					</div>
				</form>
			</FormProvider>
		</div>
	)
}
