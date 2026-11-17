import type { UiKey } from "../../src/ui/translations.js";

export type Preset = "balanced" | "lossless" | "author";
export interface Job {
  id: string;
  name: string;
  preset: Preset;
  state: "uploading" | "running" | "cancelling" | "success" | "failed" | "cancelled";
  stage: string;
  summary?: {
    inputBytes: number;
    outputBytes: number;
    reductionPercent: number;
    errors: number;
    warnings: number;
  };
  error?: string;
  errorCode?: UiKey;
  reports?: { json: boolean; html: boolean };
}
export class ApiError extends Error {
  readonly code?: UiKey;
  constructor(message: string, code?: UiKey) {
    super(message);
    this.code = code;
  }
}
export async function request<T>(
  token: string,
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "X-Epub-Token": token } });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || "Local request failed", data.code);
  return data as T;
}
export function upload(
  token: string,
  file: File,
  preset: Preset,
  progress: (value: number) => void
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs?preset=" + preset);
    xhr.setRequestHeader("Content-Type", "application/epub+zip");
    xhr.setRequestHeader("X-Epub-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Epub-Token", token);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) reject(new ApiError(data.error, data.code));
        else resolve(data as Job);
      } catch {
        reject(new ApiError("Invalid local response", "localError"));
      }
    };
    xhr.onerror = () => reject(new ApiError("Connection lost", "connectionLost"));
    xhr.onabort = () => reject(new ApiError("Connection lost", "connectionLost"));
    xhr.send(file);
  });
}
