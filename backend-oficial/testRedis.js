import "dotenv/config";

const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

async function test() {
  console.log("🔎 Testando conexão com o Redis...");
  console.log("URL:", baseUrl);

  // grava um valor
  const r1 = await fetch(`${baseUrl}/set/bepit:test/funcionou?EX=60`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("SET:", await r1.json());

  // lê o valor
  const r2 = await fetch(`${baseUrl}/get/bepit:test`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("GET:", await r2.json());
}

test().catch(console.error);
