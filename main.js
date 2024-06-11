import nodeFetch from "node-fetch";
import fetchCookie from "fetch-cookie";
import { spawn } from "child_process";
import fs from "fs";
import config from "./config.js";
import Throttle from "throttle";
import PQueue from "p-queue";

const COURSES_URL = "https://api.frontendmasters.com/v1/kabuki/courses";

const headers = {
  Origin: "https://frontendmasters.com",
  Referer: "https://frontendmasters.com/",
};

const videoQualities = {
  2160: "index_2160p_Q10_20mbps",
  1440: "index_1440p_Q10_9mbps",
  1080: "index_1080_Q10_7mbps",
  720: "index_720_Q8_5mbps",
  360: "index_360_Q8_2mbps",
};

// Configure the queue and throttle
const concurrentDownload = config.CONCURRENT_DOWNLOADS || 1;
const queue = new PQueue({ concurrency: concurrentDownload });
const downloadSpeed = config.CONCURRENT_DOWNLOADS || 1000000; // 1 Mbps (adjust as needed)
let downloadLocation = config.DOWNLOAD_LOCATION || ".";
if (downloadLocation.endsWith('/')) {
  downloadLocation = downloadLocation.slice(0, -1);
}

const main = async () => {
  const { FEM_AUTH_MOD, COURSE_URL, QUALITY } = config;
  const quality = videoQualities[QUALITY];

  const jar = new fetchCookie.toughCookie.CookieJar();
  await jar.setCookie(
    `fem_auth_mod=${FEM_AUTH_MOD}; Path=/; Domain=frontendmasters.com; HttpOnly; Secure`,
    "https://frontendmasters.com",
  );
  const fetch = fetchCookie(nodeFetch, jar);

  const courseType = COURSE_URL.replace(/\/+$/gm, "").split("/").at(-1);
  const res = await fetch(`${COURSES_URL}/${courseType}`, { headers });
  const data = await res.json();
  const title = data.title;

  if (!fs.existsSync(`${downloadLocation}/${title}`)) {
    fs.mkdirSync(`${downloadLocation}/${title}`, { recursive: true });
  }

  const lessons = Object.entries(data.lessonData).map(([k, v]) => ({
    hash: k,
    title: v.title,
    index: v.index,
  }));

  for (const lesson of lessons) {
    queue.add(() => downloadLesson(lesson, title, quality, fetch, jar));
  }

  await queue.onIdle();
};

const downloadLesson = async (lesson, title, quality, fetch, jar) => {
  const res = await fetch(
    `https://api.frontendmasters.com/v1/kabuki/video/${lesson.hash}/source?f=m3u8`,
    { headers },
  );
  const { url } = await res.json();
  const finalUrl = [...url.split("/").slice(0, -1), `${quality}.m3u8`].join("/");

  headers["Cookie"] = await jar.getCookieString(finalUrl);

  const joinedHeaders = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const throttledStream = new Throttle(downloadSpeed);

  const proc = spawn("ffmpeg", [
    "-y",
    "-headers",
    joinedHeaders,
    "-i",
    finalUrl,
    "-map",
    "0",
    "-c",
    "copy",
    `${downloadLocation}/${title}/${lesson.index}_${lesson.title}.mp4`,
  ]);

  proc.stdout.pipe(throttledStream).pipe(process.stdout);

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", function (data) {
    console.log(data);
  });

  await new Promise((resolve, reject) => {
    proc.on("close", resolve);
    proc.on("error", reject);
  });
};

await main();
