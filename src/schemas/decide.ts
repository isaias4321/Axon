import { z } from "zod";

export const decideRequestSchema = z.object({
  task: z.string().trim().min(1, "Informe a tarefa.").max(20_000),
  provider: z.enum(["openai", "anthropic", "gemini", "groq"]).optional(),
  model: z.string().min(1).optional(),
});

export type DecideRequest = z.infer<typeof decideRequestSchema>;
