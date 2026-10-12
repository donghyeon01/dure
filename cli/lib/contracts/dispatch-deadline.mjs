import { completionRequestSchema } from "./orchestration-completion.mjs";

const common = {
  schemaVersion: { type: "integer", const: 1 },
  target: completionRequestSchema.properties.target,
};

export const dispatchDeadlineSetSchema = {
  type: "object", additionalProperties: false,
  required: [...Object.keys(common), "writeCapability", "expectedDispatchRevision", "idempotencyKey", "dueAtMs", "changedAtMs"],
  properties: {
    ...common,
    writeCapability: { type: "string", minLength: 1, description: "Copy the exact Dispatch context.interactionCapability; keep it private." },
    expectedDispatchRevision: completionRequestSchema.properties.expectedDispatchRevision,
    idempotencyKey: completionRequestSchema.properties.idempotencyKey,
    dueAtMs: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Absolute Unix milliseconds, or explicit null to clear. A deadline never authorizes interruption." },
    changedAtMs: { type: "integer", minimum: 0, description: "Current Unix milliseconds; keep the complete body unchanged on retry." },
  },
};

export const dispatchDeadlineGetSchema = {
  type: "object", additionalProperties: false,
  required: [...Object.keys(common), "readCapability"],
  properties: {
    ...common,
    readCapability: { type: "string", minLength: 1, description: "Copy the exact Dispatch context.interactionCapability; keep it private." },
  },
};
