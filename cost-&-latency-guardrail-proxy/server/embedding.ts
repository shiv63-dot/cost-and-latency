const EMBEDDING_DIM = 256;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'can', 'could', 'would', 'should', 'do', 'does', 'did', 'will', 'shall',
  'please', 'tell', 'me', 'about', 'explain', 'describe', 'give', 'provide',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
  'simple', 'simply', 'terms', 'briefly', 'short', 'overview', 'summary',
  'and', 'or', 'but', 'if', 'then', 'that', 'this', 'these', 'those', 'it',
  'its', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my',
]);

const SYNONYM_CANONICAL: Record<string, string> = {
  ml: 'machine_learning',
  ai: 'artificial_intelligence',
  llm: 'large_language_model',
  llms: 'large_language_model',
  caching: 'cache',
  cached: 'cache',
  caches: 'cache',
  embeddings: 'embedding',
  vectors: 'vector',
  latency: 'latency',
  speed: 'latency',
  fast: 'latency',
  optimize: 'optimization',
  optimizing: 'optimization',
  reduce: 'reduction',
  reducing: 'reduction',
  lowering: 'reduction',
  cost: 'cost',
  costs: 'cost',
  spending: 'cost',
  expenditure: 'cost',
  price: 'cost',
  pricing: 'cost',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  containers: 'container',
  containerization: 'container',
  works: 'work',
  working: 'work',
  functioning: 'work',
};

function fnv1aHash(str: string, seed = 2166136261): number {
  let hash = seed;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenizeContent(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const rawTokens = cleaned.split(' ');
  const contentTokens: string[] = [];

  for (const token of rawTokens) {
    if (!token || STOPWORDS.has(token)) continue;
    const mapped = SYNONYM_CANONICAL[token] || token;
    contentTokens.push(mapped);
  }

  return contentTokens.length > 0 ? contentTokens : rawTokens;
}

export function generateEmbedding(text: string): number[] {
  const vector = new Float64Array(EMBEDDING_DIM);
  const tokens = tokenizeContent(text);

  if (tokens.length === 0) {
    vector[0] = 1.0;
    return Array.from(vector);
  }

  const addFeature = (feature: string, weight: number) => {
    const h1 = fnv1aHash(feature, 2166136261);
    const h2 = fnv1aHash(feature, 2166136267);
    const idx = h1 % EMBEDDING_DIM;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vector[idx] += sign * weight;
  };

  // Unigrams (high semantic signal)
  for (const token of tokens) {
    addFeature(`u:${token}`, 2.4);
    // Character 3-grams for morphological similarity
    if (token.length >= 3) {
      for (let i = 0; i <= token.length - 3; i += 1) {
        addFeature(`c3:${token.slice(i, i + 3)}`, 0.55);
      }
    }
  }

  // Bigrams (phrase level)
  for (let i = 0; i < tokens.length - 1; i += 1) {
    addFeature(`b:${tokens[i]}_${tokens[i + 1]}`, 1.8);
  }

  // L2 Normalize
  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    normSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(normSq) || 1;
  const result = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    result[i] = Number((vector[i] / norm).toFixed(6));
  }
  return result;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}
