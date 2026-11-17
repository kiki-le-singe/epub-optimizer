import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, ShieldCheck, Upload } from "lucide-react";
import { languages, uiMessages, type UiKey } from "../src/ui/translations.js";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent } from "./components/ui/card.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.js";
import { Progress } from "./components/ui/progress.js";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group.js";
import {
  applyTheme,
  initialLanguage,
  initialTheme,
  preferences,
  type Theme,
} from "./lib/preferences.js";
import { ApiError, request, upload, type Job, type Preset } from "./lib/api.js";
import { cn } from "./lib/utils.js";

const languageNames = {
  fr: "Français",
  en: "English",
  it: "Italiano",
  es: "Español",
  de: "Deutsch",
};
const themeLabels: Record<Theme, UiKey> = {
  system: "system",
  "light-green": "lightGreen",
  "light-blue": "lightBlue",
  "dark-green": "darkGreen",
  "dark-blue": "darkBlue",
};
// Keys match the "=== Stage ===" headers printed by src/optimization.ts.
const stages: Record<string, UiKey> = {
  "Optimize EPUB": "stageContent",
  "Validate Text Preservation": "stageText",
  "Validate Content Integrity": "stageIntegrity",
  "Create Candidate EPUB": "stagePackage",
  "Validate Candidate EPUB": "stageValidate",
  "Publish Validated EPUB": "stageDownload",
  Cleanup: "stageCleanup",
};
const isActive = (job: Job | null) =>
  !!job && ["uploading", "running", "cancelling"].includes(job.state);
type FormError = {
  code?: UiKey;
  message?: string;
  values?: Record<string, string | number>;
} | null;

export function App({ token, maxUpload }: { token: string; maxUpload: number }): ReactNode {
  const [language, setLanguage] = useState(initialLanguage);
  const [theme, setTheme] = useState(initialTheme);
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState<Preset>("balanced");
  const [job, setJob] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<FormError>(null);
  const epoch = useRef(0);
  const submitting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = uploading || isActive(job);
  const t = (key: UiKey, values: Record<string, string | number> = {}): string => {
    let text = uiMessages[language][key];
    for (const [name, value] of Object.entries(values))
      text = text.replaceAll("{" + name + "}", String(value));
    return text;
  };
  const size = (bytes: number) =>
    (bytes / (bytes >= 1048576 ? 1048576 : 1024)).toLocaleString(language, {
      maximumFractionDigits: 2,
    }) +
    (bytes >= 1048576
      ? language === "fr"
        ? " Mio"
        : " MiB"
      : language === "fr"
        ? " Kio"
        : " KiB");
  const showError = (value: unknown) =>
    setError(
      value instanceof ApiError
        ? { code: value.code, message: value.message }
        : { code: "connectionLost" }
    );

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = uiMessages[language].title;
    preferences.set("language", language);
  }, [language]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(theme, media.matches);
    update();
    preferences.set("theme", theme);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // One poller owns the current job. Epochs prevent late reads replacing a new upload.
  useEffect(() => {
    if (uploading) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const version = epoch.current;
    const refresh = async () => {
      try {
        const value = await request<Job | null>(token, "/api/job", { signal: controller.signal });
        if (disposed || version !== epoch.current) return;
        setJob(value);
        if (isActive(value)) {
          setPreset(value!.preset);
          timer = setTimeout(() => {
            void refresh();
          }, 700);
        }
      } catch (value) {
        if (!disposed && version === epoch.current) showError(value);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [token, uploading]);

  const selectFile = (files: FileList | File[]) => {
    if (busy || submitting.current) return;
    if (files.length !== 1) {
      setError({ code: "selectOne" });
      return;
    }
    const candidate = files[0]!;
    if (!/\.epub$/i.test(candidate.name) || !candidate.size || candidate.size > maxUpload) {
      setError({ code: "invalidFile", values: { limit: Math.floor(maxUpload / 1048576) } });
      return;
    }
    setFile(candidate);
    setError(null);
  };
  const start = async () => {
    if (!file || busy || submitting.current) return;
    submitting.current = true;
    epoch.current++;
    setError(null);
    setJob(null);
    setUploading(true);
    setUploadPercent(0);
    try {
      setJob(await upload(token, file, preset, setUploadPercent));
    } catch (value) {
      showError(value);
    } finally {
      submitting.current = false;
      setUploading(false);
    }
  };
  const cancel = async () => {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      setJob(await request<Job>(token, "/api/jobs/" + job.id + "/cancel", { method: "POST" }));
    } catch (value) {
      showError(value);
    } finally {
      setCancelling(false);
    }
  };
  const resultTitle: UiKey = uploading
    ? "uploading"
    : job?.state === "success"
      ? "readyTitle"
      : job?.state === "failed"
        ? "failedTitle"
        : job?.state === "cancelled"
          ? "cancelledTitle"
          : "processing";
  const stage: UiKey = uploading
    ? "uploadDescription"
    : job?.state === "running"
      ? (stages[job.stage] ?? "processFallback")
      : job?.state === "success"
        ? "readyDescription"
        : job?.state === "failed"
          ? "failedDescription"
          : job?.state === "cancelling"
            ? "cancelling"
            : "anotherBook";
  const presets = [
    ["balanced", "balanced", "balancedDescription"],
    ["lossless", "lossless", "losslessDescription"],
    ["author", "author", "authorDescription"],
  ] as const;

  return (
    <>
      <header className="mx-auto flex max-w-[1192px] flex-wrap items-center justify-between gap-5 border-b px-5 py-6 sm:px-8">
        <a
          href="/"
          aria-label={t("title")}
          className="flex items-center gap-3 text-[17px] font-medium tracking-tight text-primary-text"
        >
          <span className="rounded-xl bg-primary p-2 text-primary-foreground">
            <BookOpen className="size-5" aria-hidden="true" />
          </span>
          <span>
            EPUB <strong>Optimizer</strong>
          </span>
        </a>
        <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:gap-6">
          <span className="hidden items-center gap-2 text-xs text-muted-foreground min-[420px]:flex">
            <i className="size-1.5 rounded-full bg-primary ring-4 ring-primary/10" />
            {t("localBadge")}
          </span>
          <div className="space-y-1">
            <Label htmlFor="language" className="text-[10px] text-muted-foreground">
              {t("language")}
            </Label>
            <NativeSelect
              id="language"
              value={language}
              size="sm"
              className="min-w-24 text-xs"
              onChange={(event) => setLanguage(event.target.value as typeof language)}
            >
              {languages.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {languageNames[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="theme" className="text-[10px] text-muted-foreground">
              {t("theme")}
            </Label>
            <NativeSelect
              id="theme"
              value={theme}
              size="sm"
              className="min-w-32 text-xs"
              onChange={(event) => setTheme(event.target.value as Theme)}
            >
              {Object.entries(themeLabels).map(([value, key]) => (
                <NativeSelectOption key={value} value={value}>
                  {t(key)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      </header>
      <main
        className="mx-auto max-w-[1192px] px-5 pt-10 pb-8 sm:px-8 sm:pt-12"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      >
        <section className="mb-8">
          <p className="mb-4 text-[10px] font-bold tracking-[.2em] text-primary-text">
            {t("eyebrow")}
          </p>
          <h1 className="mb-5 text-[clamp(40px,4.6vw,62px)] leading-[1.08] font-semibold tracking-[-.045em]">
            {t("hero1")}
            <br />
            {t("hero2")}
            <em className="font-serif font-normal text-primary-text">{t("heroBook")}</em>
          </h1>
          <p className="max-w-[500px] text-base leading-relaxed text-muted-foreground">
            {t("lede")}
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {(["original", "validated", "noAccount"] as const).map((key) => (
              <span key={key}>{t(key)}</span>
            ))}
          </div>
        </section>
        <form
          id="optimizer"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <Card className="overflow-hidden rounded-[20px] shadow-sm">
            <CardContent className="grid p-0 md:grid-cols-[1.13fr_1fr]">
              <section className="p-6 sm:p-8">
                <PanelHeading number="01">{t("yourBook")}</PanelHeading>
                <div
                  id="drop"
                  className={cn(
                    "upload-zone flex min-h-[266px] flex-col items-center justify-center rounded-xl border border-dashed px-4 py-6 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-ring",
                    dragging && "border-primary bg-accent",
                    busy && "opacity-60"
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    selectFile(event.dataTransfer.files);
                  }}
                >
                  <Upload
                    className="mb-5 size-12 rounded-2xl border border-primary/20 p-3 text-primary-text"
                    aria-hidden="true"
                  />
                  <strong id="file-title" className="max-w-full text-base font-semibold break-all">
                    {file ? file.name : t("dropTitle")}
                  </strong>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {file ? t("readyFile", { size: size(file.size) }) : t("dropDescription")}
                  </p>
                  <input
                    ref={fileInput}
                    id="file"
                    type="file"
                    className="sr-only"
                    disabled={busy}
                    accept=".epub,application/epub+zip"
                    aria-label={t("choose")}
                    onChange={(event) => {
                      if (event.target.files) selectFile(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-5 mb-3 gap-5"
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                  >
                    {t("choose")}
                    <ArrowUpRight aria-hidden="true" />
                  </Button>
                  <small className="text-[10px] text-muted-foreground">
                    {t("limit", { limit: Math.floor(maxUpload / 1048576) })}
                  </small>
                </div>
                <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                  <ShieldCheck
                    className="mt-0.5 size-3 shrink-0 text-primary-text"
                    aria-hidden="true"
                  />
                  {t("privacy")}
                </p>
              </section>
              <section className="border-t p-6 sm:p-8 md:border-t-0 md:border-l">
                <PanelHeading number="02">{t("yourPreset")}</PanelHeading>
                <RadioGroup
                  aria-label={t("presetLegend")}
                  value={preset}
                  disabled={busy}
                  onValueChange={(value) => setPreset(value as Preset)}
                  className="gap-2.5"
                >
                  {presets.map(([value, title, description]) => (
                    <Label
                      key={value}
                      htmlFor={"preset-" + value}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors",
                        preset === value && "border-primary bg-accent",
                        busy && "cursor-not-allowed opacity-60"
                      )}
                    >
                      <RadioGroupItem
                        id={"preset-" + value}
                        value={value}
                        className="mt-0.5 shrink-0"
                      />
                      <span>
                        <span className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                          {t(title)}
                          {value === "balanced" && (
                            <Badge
                              variant="secondary"
                              className="px-1.5 py-0.5 text-[8px] tracking-wide"
                            >
                              {t("recommended")}
                            </Badge>
                          )}
                        </span>
                        <span className="mt-1 block text-[11px] leading-relaxed font-normal text-muted-foreground">
                          {t(description)}
                        </span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
                {preset === "author" && (
                  <Alert className="mt-3 border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                    <AlertDescription className="text-xs">{t("authorNote")}</AlertDescription>
                  </Alert>
                )}
                <Button
                  id="start"
                  className="mt-5 h-11 w-full justify-between"
                  disabled={busy || !file}
                  type="submit"
                >
                  {t("start")}
                  <ArrowRight aria-hidden="true" />
                </Button>
                <p className="mt-2 text-center text-[10px] text-muted-foreground">
                  {t("strictNote")}
                </p>
              </section>
            </CardContent>
          </Card>
        </form>
        {error && (
          <Alert variant="destructive" className="mt-5">
            <AlertDescription>
              {error.code ? t(error.code, error.values) : error.message}
            </AlertDescription>
          </Alert>
        )}
        {(uploading || job) && (
          <Card id="result" className="mt-6 rounded-2xl" aria-live="polite">
            <CardContent className="p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="mb-1 text-[9px] tracking-widest break-all text-primary-text">
                    {t(busy ? "processingKicker" : "resultKicker")} ·{" "}
                    {uploading ? file?.name : job?.name}
                  </p>
                  <h2 className="text-xl font-semibold tracking-tight">{t(resultTitle)}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{t(stage)}</p>
                </div>
                {job && ["running", "cancelling"].includes(job.state) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={cancelling || job.state === "cancelling"}
                    onClick={() => {
                      void cancel();
                    }}
                  >
                    {t("cancel")}
                  </Button>
                )}
              </div>
              {busy && (
                <Progress
                  aria-label={t("progressLabel")}
                  value={uploading ? uploadPercent : undefined}
                  className={cn("mt-6 h-1", !uploading && "indeterminate")}
                />
              )}
              {job?.state === "success" && job.summary && (
                <>
                  <div id="metrics" className="my-6 grid grid-cols-3 gap-3">
                    {(
                      [
                        ["before", size(job.summary.inputBytes)],
                        ["after", size(job.summary.outputBytes)],
                        [
                          "change",
                          (job.summary.reductionPercent >= 0 ? "−" : "+") +
                            Math.abs(job.summary.reductionPercent).toLocaleString(language, {
                              maximumFractionDigits: 1,
                            }) +
                            " %",
                        ],
                      ] as const
                    ).map(([key, value], index) => (
                      <div key={key} className={cn(index > 0 && "border-l pl-3 sm:pl-5")}>
                        <small className="block text-[10px] text-muted-foreground">{t(key)}</small>
                        <strong
                          className={cn(
                            "mt-1 block text-lg font-medium tracking-tight whitespace-nowrap sm:text-3xl",
                            index === 2 && job.summary!.reductionPercent > 0 && "text-primary-text"
                          )}
                        >
                          {value}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="rounded-md bg-accent px-3 py-2 text-[11px] text-foreground">
                    <ShieldCheck
                      className="mr-2 inline size-3.5 text-primary-text"
                      aria-hidden="true"
                    />
                    {t("validation")}
                  </p>
                </>
              )}
              {(job?.errorCode || job?.error) && (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription className="whitespace-pre-wrap break-words">
                    {[job.errorCode ? t(job.errorCode) : "", job.error]
                      .filter(Boolean)
                      .join("\n\n")}
                  </AlertDescription>
                </Alert>
              )}
              {job && (
                <div className="mt-5 flex flex-wrap items-center gap-5">
                  {job.state === "success" && (
                    <Button asChild>
                      <a id="download" href={"/api/jobs/" + job.id + "/download"}>
                        {t("download")}
                        <ArrowDown aria-hidden="true" />
                      </a>
                    </Button>
                  )}
                  {(["html", "json"] as const).map(
                    (kind) =>
                      job.reports?.[kind] && (
                        <a
                          key={kind}
                          id={kind + "-report"}
                          href={"/api/jobs/" + job.id + "/" + kind}
                          className="text-xs text-muted-foreground underline underline-offset-4"
                        >
                          {t(kind === "html" ? "htmlReport" : "jsonReport")}
                        </a>
                      )
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
        <footer className="mt-8 grid gap-2 border-t pt-6 text-[11px] sm:grid-cols-[1fr_auto]">
          <strong className="font-semibold">{t("footerTitle")}</strong>
          <span className="text-[10px] text-muted-foreground sm:col-start-2 sm:row-span-2">
            {t("footerBrand")}
          </span>
          <p className="max-w-3xl text-[10px] leading-relaxed text-muted-foreground sm:row-start-2">
            {t("footerBody")}
          </p>
        </footer>
      </main>
    </>
  );
}

function PanelHeading({ number, children }: { number: string; children: ReactNode }): ReactNode {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="grid size-6 place-items-center rounded-full border text-[10px] text-muted-foreground">
        {number}
      </span>
      <h2 className="text-sm font-semibold tracking-tight">{children}</h2>
    </div>
  );
}
