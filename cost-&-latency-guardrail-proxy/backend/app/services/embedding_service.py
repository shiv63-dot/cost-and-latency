import hashlib
import math
import re
from typing import List, Optional

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "what", "which", "who", "where", "when", "why", "how", "can", "could",
    "would", "should", "do", "does", "did", "please", "tell", "me", "about",
    "explain", "describe", "in", "on", "at", "to", "for", "of", "with",
    "simple", "simply", "terms", "briefly", "and", "or", "it", "this",
}

_SYNONYMS = {
    "ml": "machine_learning",
    "ai": "artificial_intelligence",
    "llm": "large_language_model",
    "caching": "cache",
    "cached": "cache",
    "caches": "cache",
    "embeddings": "embedding",
    "postgres": "postgresql",
    "k8s": "kubernetes",
}


class EmbeddingService:
    def __init__(self, model_name: str = "all-MiniLM-L6-v2", enable_transformer: bool = True):
        self.model_name = model_name
        self._st_model: Optional[object] = None
        if enable_transformer:
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore

                self._st_model = SentenceTransformer(model_name)
            except Exception:
                self._st_model = None

    def embed(self, text: str) -> List[float]:
        if self._st_model is not None:
            vec = self._st_model.encode(text, normalize_embeddings=True)  # type: ignore
            return [float(x) for x in vec.tolist()]
        return self._deterministic_semantic_embed(text)

    def _deterministic_semantic_embed(self, text: str, dim: int = 256) -> List[float]:
        cleaned = re.sub(r"[^a-z0-9\s]", " ", text.lower())
        raw_tokens = [t for t in cleaned.split() if t]
        tokens = [_SYNONYMS.get(t, t) for t in raw_tokens if t not in _STOPWORDS] or raw_tokens

        vec = [0.0] * dim
        if not tokens:
            vec[0] = 1.0
            return vec

        def add_feature(feat: str, weight: float) -> None:
            digest = hashlib.sha256(feat.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % dim
            sign = 1.0 if (digest[4] & 1) == 0 else -1.0
            vec[idx] += sign * weight

        for tok in tokens:
            add_feature(f"u:{tok}", 2.4)
            if len(tok) >= 3:
                for i in range(len(tok) - 2):
                    add_feature(f"c3:{tok[i:i+3]}", 0.55)

        for i in range(len(tokens) - 1):
            add_feature(f"b:{tokens[i]}_{tokens[i+1]}", 1.8)

        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [round(v / norm, 6) for v in vec]


def cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
