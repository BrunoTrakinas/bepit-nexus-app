import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Variável de ambiente GEMINI_API_KEY ausente. Defina-a no .env do servidor.");
  process.exit(1);
}

const application = express();
const serverPort = process.env.PORT || 3002;

const googleGenerativeArtificialIntelligenceClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

const crossOriginResourceSharingOptions = {
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://seu-site-bepit.netlify.app"
  ],
  credentials: true,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

application.use(cors(crossOriginResourceSharingOptions));
application.options("*", cors(crossOriginResourceSharingOptions));
application.use(express.json());

application.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    service: "bepit-robot-brain",
    port: serverPort,
    timestamp: new Date().toISOString()
  });
});

application.post("/api/chat", async (request, response) => {
  try {
    const userRequestBody = request.body || {};
    const userMessageText = userRequestBody.message;

    if (typeof userMessageText !== "string" || userMessageText.trim().length === 0) {
      return response
        .status(400)
        .json({ error: "Campo 'message' é obrigatório e deve ser uma string não vazia." });
    }

    const generativeModel = googleGenerativeArtificialIntelligenceClient.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    const promptText = `
Você é o BEPIT, um atendente educado e objetivo. Responda em português do Brasil.
Seja breve, claro e útil.

Pergunta do usuário:
"${userMessageText}"
    `.trim();

    const modelResult = await generativeModel.generateContent(promptText);
    const modelResponse = modelResult.response;
    const modelText = modelResponse.text();

    return response.status(200).json({ reply: modelText });
  } catch (error) {
    console.error("[/api/chat] Erro interno:", {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      responseStatus: error?.response?.status,
      responseData: error?.response?.data
    });
    return response.status(500).json({ error: "Erro interno no cérebro do robô." });
  }
});

application.use((request, response) => {
  response.status(404).json({
    error: `Rota não encontrada: ${request.method} ${request.originalUrl}`
  });
});

application.listen(serverPort, () => {
  console.log(`🤖 Servidor do cérebro do robô em execução em http://localhost:${serverPort}`);
});
