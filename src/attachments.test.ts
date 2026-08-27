import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type Attachment, buildContent } from "./attachments.js";

const img = (name = "shot.png"): Attachment => ({
	name,
	mimeType: "image/png",
	data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
});
const file = (name = "report.pdf"): Attachment => ({
	name,
	mimeType: "application/pdf",
	data: Buffer.from("hello"),
});

test("images become base64 image parts, plus a trailing text part", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-att-"));
	const parts = buildContent("look at this", [img()], dir, 1000);

	expect(parts.length).toBe(2);
	expect(parts[0]!.type).toBe("image");
	const imgPart = parts[0] as Extract<
		(typeof parts)[number],
		{ type: "image" }
	>;
	expect(imgPart.source.media_type).toBe("image/png");
	expect(imgPart.source.data.length > 0).toBeTruthy();
	expect(parts[1]).toEqual({ type: "text", text: "look at this" });
});

test("non-image files are saved to disk and referenced by path", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-att-"));
	const parts = buildContent("", [file()], dir, 1234);

	// Only a text part (no image part) and it mentions the saved path.
	expect(parts.length).toBe(1);
	const textPart = parts[0] as Extract<
		(typeof parts)[number],
		{ type: "text" }
	>;
	expect(textPart.text.includes("please read them")).toBeTruthy();
	expect(textPart.text.includes("report.pdf")).toBeTruthy();

	// The file was actually written under <dir>/.iris/attachments.
	const saved = readdirSync(join(dir, ".iris", "attachments"));
	expect(saved.length).toBe(1);
	expect(saved[0]!.includes("report.pdf")).toBeTruthy();
});

test("empty prompt gets a default for image-only and file-only messages", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-att-"));
	const imgOnly = buildContent("", [img()], dir, 1);
	const textPart = imgOnly.at(-1) as { type: "text"; text: string };
	expect(textPart.text.includes("image")).toBeTruthy();
});

test("mixed image + file produces an image part and a file reference", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-att-"));
	const parts = buildContent("check both", [img(), file()], dir, 9);
	const kinds = parts.map((p) => p.type);
	expect(kinds).toEqual(["image", "text"]);
	const textPart = parts[1] as { type: "text"; text: string };
	expect(textPart.text.includes("check both")).toBeTruthy();
	expect(textPart.text.includes("report.pdf")).toBeTruthy();
});
