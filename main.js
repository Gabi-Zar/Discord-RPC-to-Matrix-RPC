import "dotenv/config";
import Server from "arrpc/src/server.js";
import fs from "fs/promises";

let activitiesCache = null;
let activityNamesCache = [];
let getAppInfoQueue = [];
let refreshTimeout;

const appCache = await loadOrCreateAppCache();
const activities = new Map();
const arrpc = await new Server();

arrpc.on("activity", async (data) => {
    const key = data.socketId ?? data.pid;

    if (data.activity) {
        activities.set(key, data.activity);
    } else {
        activities.delete(key);
    }

    console.log(`Ongoing activities: ${activities.size}`);
    if (process.env.USE_PROFILE_FIELD === "true") {
        const parsedActivities = await parseActivities(activities);
        if (!parsedActivities) return;
        if (!hasActivitiesChanged(parsedActivities)) return;
        await setMatrixRPC(parsedActivities);
    }
    if (process.env.USE_PRESENCE_STATUS === "true") {
        const parsedActivityNames = await parseActivityNames(activities);
        if (!parsedActivityNames) return;
        if (!hasActivityNamesChanged(parsedActivityNames)) return;
        await setMatrixStatus(parsedActivityNames);
    }
});

async function cleanup() {
    console.log("\nExiting cleanly");

    if (process.env.USE_PROFILE_FIELD === "true") {
        await setMatrixRPC([]);
    }
    if (process.env.USE_PRESENCE_STATUS === "true") {
        await setMatrixStatus([]);
    }
    process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function parseActivities(activities) {
    const results = [];
    if (activities.size === 0) return results;

    for (const activity of activities.values()) {
        const appInfo = await getAppInfo(activity.application_id);
        if (!appInfo) return false;

        if (activity.type === 2 && process.env.PROCESS_MUSIC === "false") return results;
        if (activity.type === 2) {
            results.push({
                id: activity.application_id,
                type: "xyz.extera.msc4544.rpc.music",
                track: activity.details,
                artist: activity.state,
                album: activity.assets?.large_text.replace("album: ", ""),
                cover_url: await getAppImageMatrixUrl(
                    activity.application_id,
                    activity.assets?.large_image ?? `https://cdn.discordapp.com/app-icons/${activity.application_id}/${appInfo.icon.id}?size=128`,
                ),
                progress: {
                    since: activity.timestamps?.start,
                    until: activity.timestamps?.end,
                },
            });
        } else {
            results.push({
                id: activity.application_id,
                type: "xyz.extera.msc4544.rpc.activity",
                name: activity.name ?? appInfo.name,
                large_icon_url: await getAppImageMatrixUrl(
                    activity.application_id,
                    activity.assets?.large_image ?? `https://cdn.discordapp.com/app-icons/${activity.application_id}/${appInfo.icon.id}?size=128`,
                ),
                large_icon_tooltip: activity.assets?.large_text,
                small_icon_url: await getAppImageMatrixUrl(activity.application_id, activity.assets?.small_image),
                small_icon_tooltip: activity.assets?.small_text,
                details: activity.details,
                state: activity.state,
                since: activity.timestamps?.start,
                until: activity.timestamps?.end,
            });
        }
    }
    return results;
}

async function parseActivityNames(activities) {
    const results = [];
    for (const activity of activities.values()) {
        if (activity.type !== 0) continue;
        if (!activity.name) {
            const appInfo = await getAppInfo(activity.application_id);
            if (!appInfo) return false;
            results.push(appInfo.name);
        } else {
            results.push(activity.name);
        }
    }
    return results;
}

function hasActivitiesChanged(activities) {
    if (JSON.stringify(activities) === JSON.stringify(activitiesCache)) return false;
    activitiesCache = activities;
    return true;
}

function hasActivityNamesChanged(activityNames) {
    if (activityNamesCache.length === activityNames.length && activityNamesCache.every((str, i) => str === activityNames[i])) return false;
    activityNamesCache = activityNames;
    return true;
}

async function setMatrixRPC(activities) {
    const url = `${process.env.SERVER_URL}/_matrix/client/v3/profile/${encodeURIComponent(process.env.MATRIX_USER_ID)}/xyz.extera.msc4544.rpc`;
    clearTimeout(refreshTimeout);

    if (activities.length === 0) {
        const res = await fetch(url, {
            method: "DELETE",
            headers: {
                Authorization: `Bearer ${process.env.TOKEN}`,
            },
        });
        console.log(res.status);
    } else {
        refreshTimeout = setTimeout(() => setMatrixRPC(activitiesCache), Number(process.env.EXPIRY) - 5000);
        const body = JSON.stringify({
            "xyz.extera.msc4544.rpc": activities.map((activity) => ({
                ...activity,
                expiry: Date.now() + Number(process.env.EXPIRY),
            })),
        });

        const res = await fetch(url, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.TOKEN}`,
            },
            body,
        });
        console.log(res.status);
    }
}

async function setMatrixStatus(activities) {
    const url = `${process.env.SERVER_URL}/_matrix/client/v3/presence/${encodeURIComponent(process.env.MATRIX_USER_ID)}/status`;

    let statusMessage = "";
    if (activities.length > 0) statusMessage = "Playing";
    for (let i = 0; i < activities.length; i++) {
        if (i > 0 && i === activities.length - 1) {
            statusMessage = statusMessage.concat(" and");
        }
        statusMessage = statusMessage.concat(` ${activities[i]}`);
        if (i > 1 && i !== activities.length - 1) {
            statusMessage = statusMessage.concat(",");
        }
    }
    console.log(statusMessage);
    const res = await fetch(url, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${process.env.TOKEN}`,
        },
        body: JSON.stringify({
            presence: "online",
            status_msg: statusMessage,
        }),
    });
    console.log(res.status);
}

async function getAppImageMatrixUrl(appId, url) {
    if (!url) return;

    if (url in appCache.get(appId).icon) {
        return appCache.get(appId).icon[url];
    }

    try {
        const imageRes = await fetch(url);
        if (!imageRes.ok) return "";

        const contentType = imageRes.headers.get("content-type") ?? "image/png";
        const body = Buffer.from(await imageRes.arrayBuffer());

        const matrixRes = await fetch(`${process.env.SERVER_URL}/_matrix/media/v3/upload?filename=${encodeURIComponent(crypto.randomUUID())}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.TOKEN}`,
                "Content-Type": contentType,
            },
            body,
        });
        if (!matrixRes.ok) return "";

        const { content_uri } = await matrixRes.json();
        appCache.get(appId).icon[url] = content_uri;
        await storeAppCache();
        return content_uri;
    } catch (err) {
        console.warn(err);
        return "";
    }
}

async function getAppInfo(id) {
    if (appCache.has(id)) {
        return appCache.get(id);
    } else {
        if (getAppInfoQueue.includes(id)) {
            console.log("nope");
            return false;
        }
        console.log("fetching new data for app:", id);
        getAppInfoQueue.push(id);
        try {
            const res = await fetch("https://discordgate.com/api/tools/lookup/applications/add", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    botId: id,
                    fingerprint: "",
                }),
            });
            let json = await res.json();
            appCache.set(id, {
                name: json?.botData?.name,
                icon: { id: json?.botData?.icon },
            });
            getAppInfoQueue.splice(getAppInfoQueue.indexOf(id), 1);
            await storeAppCache();
            return appCache.get(id);
        } catch (err) {
            console.warn(err);
            getAppInfoQueue.splice(getAppInfoQueue.indexOf(id), 1);
            return { name: id };
        }
    }
}

async function loadOrCreateAppCache() {
    try {
        const map = new Map(Object.entries(JSON.parse(await fs.readFile("./appCache.json", "utf-8"))));
        console.log("AppCache loaded from disk");
        return map;
    } catch (err) {
        console.log("New appCache created");
        return new Map();
    }
}

async function storeAppCache() {
    try {
        await fs.writeFile("./appCache.json", JSON.stringify(Object.fromEntries(appCache)));
    } catch (err) {
        console.log("Error while writing appCache to disk", err);
    }
}
