import { defineEventHandler } from 'h3';

export default defineEventHandler(async (event) => {
    try {
        const response = await fetch("https://ai.hackclub.com/up");

        if (!response.ok) {
            console.error(`Health check failed: ${response.status} ${response.statusText}`);
            return { status: "down", reason: "api_unreachable" };
        }

        const data = await response.json();
        // Return full data for client-side decision making
        return {
            status: data.status || "up",
            dailyKeyUsageRemaining: data.dailyKeyUsageRemaining,
            balanceRemaining: data.balanceRemaining,
            timestamp: data.timestamp
        };
    } catch (error) {
        return { status: "down", reason: "network_error" };
    }
});
