import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";

try {
  await copyFile("wrangler.example.jsonc", "wrangler.jsonc", constants.COPYFILE_EXCL);
  console.log("Created wrangler.jsonc. Replace its example values before deploying.");
} catch (error) {
  if (error?.code === "EEXIST") {
    console.log("wrangler.jsonc already exists; left it unchanged.");
  } else {
    throw error;
  }
}
