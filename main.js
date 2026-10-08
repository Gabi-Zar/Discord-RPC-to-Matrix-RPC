import "dotenv/config";
import Server from "arrpc/src/server.js";
import fs from "fs/promises";

let activitiesCache = null;
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

    const parsedActivities = await parseActivities(activities);

    if (!parsedActivities) return;
    if (!hasActivitiesChanged(parsedActivities)) return;

    console.log(`Ongoing activities: ${activities.size}`);
    //console.log(JSON.stringify({ "xyz.extera.msc4544.rpc": parsedActivities }));
    await setMatrixRPC(parsedActivities);
});

async function parseActivities(activities) {
    const results = [];
    if (activities.size === 0) return results;

    for (const activity of activities.values()) {
        const appInfo = await getAppInfo(activity.application_id);
        if (!appInfo) return false;

        results.push({
            id: activity.application_id,
            type: "xyz.extera.msc4544.rpc.activity",
            name: activity.name ?? appInfo.name,
            large_icon_url: appInfo.icon.matrixUrl ?? (await DiscordImageToMatrixImage(activity.application_id, appInfo.icon.id)),
            details: activity.details,
            state: activity.state,
            since: activity.timestamps?.start,
        });
    }
    return results;
}

function hasActivitiesChanged(activities) {
    if (JSON.stringify(activities) === JSON.stringify(activitiesCache)) return false;
    activitiesCache = activities;
    return true;
}

async function setMatrixRPC(activities) {
    const url = `${process.env.SERVER_URL}/_matrix/client/v3/profile/${encodeURIComponent(process.env.MATRIX_USER_ID)}/xyz.extera.msc4544.rpc`;
    clearTimeout(refreshTimeout);

    if (activities.length === 0) {
        let res = await fetch(url, {
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

        let res = await fetch(url, {
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

async function DiscordImageToMatrixImage(appId, iconId) {
    try {
        const imageRes = await fetch(`https://cdn.discordapp.com/app-icons/${appId}/${iconId}?size=128`);
        if (!imageRes.ok) return "";

        const contentType = imageRes.headers.get("content-type") ?? "image/png";
        const body = Buffer.from(await imageRes.arrayBuffer());

        const matrixRes = await fetch(`${process.env.SERVER_URL}/_matrix/media/v3/upload?filename=${encodeURIComponent(iconId)}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.TOKEN}`,
                "Content-Type": contentType,
            },
            body,
        });
        if (!matrixRes.ok) return "";

        const { content_uri } = await matrixRes.json();
        appCache.get(appId).icon.matrixUrl = content_uri;
        await storeAppCache();
        return content_uri;
    } catch (err) {
        console.warn(err);
        return "";
    }
}

async function getAppInfo(id) {
    if (appCache.get(id)) {
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
