# HOW THIS IS USED
# First, scenes are split through keyframes the same as they were before
# Then, we run this on the *end and start* of adjacent clips to see if they are part of the same scene.
# IF they are part of the same scene, we merge them into being the "same scene"

import cv2
import numpy as np


def downscale_frame(frame, size=(32, 32), grayscale=True):
    small = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)

    if grayscale:
        small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    return small.astype(np.float32) / 255.0


def mse(a, b):
    return np.mean((a - b) ** 2)


def cosine_similarity(a, b):
    a_flat = a.flatten()
    b_flat = b.flatten()
    return np.dot(a_flat, b_flat) / (
        np.linalg.norm(a_flat) * np.linalg.norm(b_flat) + 1e-8
    )


def find_same_scene_pairs(
    thumbnail_paths: list[str],
    threshold: float = 0.97,
) -> list[bool]:
    """
    For each adjacent pair (i, i+1), returns True if the clips appear to be
    the same scene based on cosine similarity of their thumbnails.

    Returns a list of length len(thumbnail_paths) - 1.
    """
    results = []

    for i in range(len(thumbnail_paths) - 1):
        img_a = cv2.imread(thumbnail_paths[i])
        img_b = cv2.imread(thumbnail_paths[i + 1])

        if img_a is None or img_b is None:
            results.append(False)
            continue

        small_a = downscale_frame(img_a)
        small_b = downscale_frame(img_b)

        sim = cosine_similarity(small_a, small_b)
        results.append(sim >= threshold)

    return results
