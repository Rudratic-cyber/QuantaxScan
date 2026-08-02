import { Router } from "express";
import { z } from "zod";

let openai: any = null;
try {
  const mod = await import("@workspace/integrations-openai-ai-server");
  openai = mod.openai;
} catch (e) {
  console.warn("OpenAI integration not available:", e instanceof Error ? e.message : "Unknown error");
}

const router = Router();

const MsgSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const BodySchema = z.object({
  messages: z.array(MsgSchema).min(1),
  systemContext: z.string().optional(),
  briefMode: z.boolean().optional(),
});

router.post("/chat", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  if (!openai) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const errorMsg = "AI analysis unavailable. The OpenAI integration is not configured.";
    res.write(`data: ${JSON.stringify({ content: errorMsg })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const { messages, systemContext, briefMode } = parsed.data;

  const briefInstruction = briefMode
    ? "\n\nCRITICAL: Reply in EXACTLY 2-3 sentences. Plain prose only — no bullet points, no headers, no code blocks. Be specific and direct."
    : "";

  const systemPrompt = `You are QuantaXscan AI — a post-quantum cryptography security expert embedded in a code IDE. Help developers understand quantum vulnerabilities and migrate to NIST PQC standards.

Key facts:
- RSA, ECDSA, ECDH, DH, DSA are broken by Shor's algorithm on quantum computers
- MD5, SHA-1 are weakened by Grover's algorithm (security halved)
- NIST standards: FIPS 203 (ML-KEM/Kyber) for key encapsulation, FIPS 204 (ML-DSA/Dilithium) for signatures, FIPS 205 (SLH-DSA/SPHINCS+) for hash-based signatures
- Symmetric: AES-256 and SHA-256+ are considered quantum-safe (Grover only halves security)

${systemContext ? `\nScan context:\n${systemContext}` : ""}
${briefInstruction}
${!briefMode ? "Be concise, technical, and always provide concrete code examples for migrations. Use markdown formatting." : ""}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const chatModel = process.env.AI_CHAT_MODEL?.trim() || "gpt-4o-mini";

  try {
    const stream = await openai.chat.completions.create({
      model: chatModel,
      max_completion_tokens: briefMode ? 180 : 8192,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Chat completion error");
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ content: `\n\n⚠️ **AI Service Error**: ${errorMsg}\n\nPlease check your API configuration and try again.` })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
});

export default router;
