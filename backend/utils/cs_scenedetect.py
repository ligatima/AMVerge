import numpy as np
from PIL import Image


def cosine_similarity(a, b):
    a_flat = a.flatten().astype(float)
    b_flat = b.flatten().astype(float)
    return np.dot(a_flat, b_flat) / (
        np.linalg.norm(a_flat) * np.linalg.norm(b_flat) + 1e-8
    )


def check_pair_similar(path_a: str, path_b: str, threshold: float = 0.91) -> bool:
    try:
        img_a = np.array(Image.open(path_a).convert("RGB"))
        img_b = np.array(Image.open(path_b).convert("RGB"))
    except Exception:
        return False
    sim = cosine_similarity(img_a, img_b)
    return sim >= threshold