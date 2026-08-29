import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default('')
});

const RawContextSchema = z.object({
  secrets: z.record(z.string(), z.string().optional()).optional().default({}),
  task: TaskSchema.optional(),
  paperclipIssue: TaskSchema.optional()
}).catchall(z.unknown());

export const CtxContextSchema = RawContextSchema.transform((context, ctx) => {
  const task = context.task ?? context.paperclipIssue;
  if (!task) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['task'],
      message: 'Either task or paperclipIssue is required'
    });
    return z.NEVER;
  }

  return { ...context, task };
});

export const HostContextSchema = z.object({
  abortSignal: z.instanceof(AbortSignal).optional()
}).catchall(z.unknown());
