// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { ApiError, request, upload, type Job } from "./lib/api.js";

vi.mock("./lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api.js")>()),
  request: vi.fn(),
  upload: vi.fn(),
}));
const requestMock = vi.mocked(request),
  uploadMock = vi.mocked(upload);
const success: Job = {
  id: "fixture-job",
  name: "book.epub",
  preset: "balanced",
  state: "success",
  stage: "Cleanup",
  summary: {
    inputBytes: 1048576,
    outputBytes: 524288,
    reductionPercent: 50,
    errors: 0,
    warnings: 0,
  },
  reports: { json: true, html: true },
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("epub-optimizer-language", "en");
  requestMock.mockResolvedValue(null);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const show = () => render(<App token="private-session" maxUpload={1024 * 1024} />);
const choose = async (user: ReturnType<typeof userEvent.setup>) => {
  const file = new File(["generated fixture"], "book.epub", { type: "application/epub+zip" });
  await user.upload(screen.getByLabelText("Choose an EPUB"), file);
  return file;
};

it("retains the selected book while switching all languages and four persistent themes", async () => {
  const user = userEvent.setup();
  const view = show();
  await choose(user);
  const theme = screen.getByLabelText("Theme");
  for (const value of ["dark-blue", "light-blue", "dark-green", "light-green"]) {
    await user.selectOptions(theme, value);
    expect(document.documentElement.dataset.theme).toBe(value.split("-")[0]);
    expect(document.documentElement.dataset.accent).toBe(value.split("-")[1]);
  }
  const language = screen.getByLabelText("Language");
  for (const value of ["fr", "it", "es", "de", "en"]) {
    await user.selectOptions(language, value);
    expect(document.documentElement.lang).toBe(value);
    expect(screen.getByText("book.epub")).toBeTruthy();
  }
  view.unmount();
  show();
  expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("light-green");
  expect(document.documentElement.lang).toBe("en");
});
it("uploads the selected preset once, shows real progress, then exposes validated downloads", async () => {
  const user = userEvent.setup();
  show();
  const file = await choose(user);
  await user.click(screen.getByRole("radio", { name: /Lossless/ }));
  let complete!: (job: Job) => void;
  uploadMock.mockImplementation((_token, _file, _preset, progress) => {
    progress(42);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const start = screen.getByRole("button", { name: "Optimize my EPUB" });
  await user.click(start);
  await user.click(start);
  expect(uploadMock).toHaveBeenCalledTimes(1);
  expect(uploadMock).toHaveBeenCalledWith(
    "private-session",
    file,
    "lossless",
    expect.any(Function)
  );
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  requestMock.mockResolvedValue(success);
  complete(success);
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toBe(
      "/api/jobs/fixture-job/download"
    )
  );
  expect(screen.getByText("−50 %")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("link", { name: /HTML/ }).getAttribute("href")).toBe(
    "/api/jobs/fixture-job/html"
  );
});
it("restores an active job and cancels it without offering an EPUB download", async () => {
  const user = userEvent.setup();
  const running = { ...success, state: "running", preset: "author" } as Job;
  requestMock.mockResolvedValue(running);
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
  expect(
    (screen.getByRole("radio", { name: /Author/ }) as HTMLElement).getAttribute("aria-checked")
  ).toBe("true");
  requestMock.mockResolvedValue({
    ...running,
    state: "cancelled",
    reports: { json: false, html: false },
  });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: /cancelled/i })).toBeTruthy());
  expect(requestMock).toHaveBeenCalledWith("private-session", "/api/jobs/fixture-job/cancel", {
    method: "POST",
  });
  expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
});
it("names the pipeline's real stage headers instead of the generic progress text", async () => {
  // Headers printed by src/optimization.ts as "=== <stage> ===" and relayed by the worker.
  const expected = {
    "Optimize EPUB": "Optimizing content",
    "Validate Text Preservation": "Checking text preservation",
    "Validate Content Integrity": "Checking content integrity",
    "Create Candidate EPUB": "Creating the optimized book",
    "Validate Candidate EPUB": "EPUBCheck validation",
    "Publish Validated EPUB": "Preparing your download",
    Cleanup: "Cleaning up",
  };
  for (const [stage, label] of Object.entries(expected)) {
    requestMock.mockResolvedValue({ ...success, state: "running", stage });
    const view = show();
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
    view.unmount();
  }
});
it("localizes failures, keeps engine diagnostics as text and never links failed output", async () => {
  requestMock.mockResolvedValue({
    ...success,
    state: "failed",
    errorCode: "timeout",
    error: "<img src=x onerror=alert(1)>",
  });
  const user = userEvent.setup();
  show();
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  await user.selectOptions(screen.getByLabelText("Language"), "fr");
  expect(screen.getByRole("alert").textContent).toContain("<img src=x onerror=alert(1)>");
  expect(document.querySelector("img")).toBeNull();
  expect(document.getElementById("download")).toBeNull();
  expect(screen.getByRole("link", { name: /JSON/ })).toBeTruthy();
});
it("rejects multiple dropped files and recovers from an upload error", async () => {
  const user = userEvent.setup();
  show();
  fireEvent.drop(document.getElementById("drop")!, {
    dataTransfer: { files: [new File(["a"], "a.epub"), new File(["b"], "b.epub")] },
  });
  expect(screen.getByRole("alert")).toBeTruthy();
  await choose(user);
  uploadMock.mockRejectedValue(new ApiError("technical fallback", "connectionLost"));
  await user.click(screen.getByRole("button", { name: "Optimize my EPUB" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("connection"));
  expect(
    (screen.getByRole("button", { name: "Optimize my EPUB" }) as HTMLButtonElement).disabled
  ).toBe(false);
});
