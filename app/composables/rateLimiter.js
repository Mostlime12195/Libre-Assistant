/**
 * @file rateLimiter.js
 * @description Client-side daily rate limiter using localStorage for persistence.
 * Limits: 96 general requests/day, 8 image generation requests/day.
 * Resets at midnight local time.
 */

import { ref, computed } from 'vue';

// Rate limit configuration
const GENERAL_LIMIT = 96;
const IMAGE_LIMIT = 8;
const STORAGE_KEY = 'libre_rate_limits';

// Image generation model IDs
const IMAGE_GENERATION_MODELS = [
    'google/gemini-2.5-flash-image',
    'google/gemini-3-pro-image-preview'
];

/**
 * Get the start of today (midnight) in epoch milliseconds
 */
function getTodayStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getNextResetTime() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

/**
 * Load rate limit data from localStorage
 */
function loadRateLimitData() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return null;
        return JSON.parse(stored);
    } catch (e) {
        console.error('Failed to load rate limit data:', e);
        return null;
    }
}

/**
 * Save rate limit data to localStorage
 */
function saveRateLimitData(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('Failed to save rate limit data:', e);
    }
}

/**
 * Get or create rate limit data for today
 */
function getOrCreateTodayData() {
    const todayStart = getTodayStart();
    const stored = loadRateLimitData();

    // If no data or data is from a previous day, create fresh data
    if (!stored || stored.dayStart !== todayStart) {
        const freshData = {
            dayStart: todayStart,
            generalCount: 0,
            imageCount: 0
        };
        saveRateLimitData(freshData);
        return freshData;
    }

    return stored;
}

// Reactive state
const rateLimitData = ref(getOrCreateTodayData());

export const usageStats = computed(() => {
  const data = rateLimitData.value;
  return {
    general: {
      used: data.generalCount,
      limit: GENERAL_LIMIT,
      remaining: Math.max(0, GENERAL_LIMIT - data.generalCount)
    },
    image: {
      used: data.imageCount,
      limit: IMAGE_LIMIT,
      remaining: Math.max(0, IMAGE_LIMIT - data.imageCount)
    }
  };
});

/**
 * Check if a model is an image generation model
 */
function isImageGenerationModel(modelId) {
    return IMAGE_GENERATION_MODELS.includes(modelId);
}

/**
 * Check if a request can be sent
 * @param {string} modelId - The model ID being used
 * @returns {{ canSend: boolean, remaining: number, limit: number, isImageModel: boolean, error?: string }}
 */
function checkLimit(modelId) {
    // Refresh data in case day changed
    rateLimitData.value = getOrCreateTodayData();

    const isImage = isImageGenerationModel(modelId);
    const count = isImage ? rateLimitData.value.imageCount : rateLimitData.value.generalCount;
    const limit = isImage ? IMAGE_LIMIT : GENERAL_LIMIT;
    const remaining = Math.max(0, limit - count);

    if (count >= limit) {
        const type = isImage ? 'image generation' : 'general';
        return {
            canSend: false,
            remaining: 0,
            limit,
            isImageModel: isImage,
            error: `Daily ${type} limit reached (${limit}/${limit}). Try again tomorrow or use your own API key.`
        };
    }

    return {
        canSend: true,
        remaining,
        limit,
        isImageModel: isImage
    };
}

/**
 * Record a request (increment counter)
 * @param {string} modelId - The model ID being used
 */
function recordRequest(modelId) {
    // Refresh data in case day changed
    rateLimitData.value = getOrCreateTodayData();

    const isImage = isImageGenerationModel(modelId);
    const next = {
        ...rateLimitData.value,
        generalCount: rateLimitData.value.generalCount + (isImage ? 0 : 1),
        imageCount: rateLimitData.value.imageCount + (isImage ? 1 : 0)
    };
    rateLimitData.value = next;
    saveRateLimitData(next);
}

/**
 * Get current usage stats
 */
function getUsageStats() {
    rateLimitData.value = getOrCreateTodayData();

    return {
        general: {
            used: rateLimitData.value.generalCount,
            limit: GENERAL_LIMIT,
            remaining: Math.max(0, GENERAL_LIMIT - rateLimitData.value.generalCount)
        },
        image: {
            used: rateLimitData.value.imageCount,
            limit: IMAGE_LIMIT,
            remaining: Math.max(0, IMAGE_LIMIT - rateLimitData.value.imageCount)
        }
    };
}

/**
 * Composable for rate limiting
 */
export function useRateLimiter() {
    return {
        checkLimit,
        recordRequest,
        getUsageStats,
        usageStats,
        getNextResetTime,
        isImageGenerationModel,
        GENERAL_LIMIT,
        IMAGE_LIMIT
    };
}
