import axios from "axios";

const rawBase = (import.meta.env.VITE_ORTHANC_BASE_RQ as string | undefined)?.trim() ?? '';
if (!rawBase) throw new Error("VITE_ORTHANC_BASE_RQ is not set");

const base = (() => {
  const ensureTrailingSlash = (value: string) => `${value.replace(/\/+$/, '')}/`;
  if (/^https?:\/\//i.test(rawBase)) {
    return ensureTrailingSlash(rawBase);
  }

  const workerBase = (import.meta.env.VITE_WORKER_API as string | undefined)?.trim();
  if (!workerBase) {
    throw new Error("Relative VITE_ORTHANC_BASE_RQ requires VITE_WORKER_API");
  }
  const workerRoot = workerBase.replace(/\/+$/, '');
  const path = rawBase.startsWith('/') ? rawBase : `/${rawBase}`;
  return ensureTrailingSlash(`${workerRoot}${path}`);
})();

const username = (import.meta.env.VITE_ORTHANC_USER as string | undefined)?.trim();
const password = (import.meta.env.VITE_ORTHANC_PASS as string | undefined)?.trim();
const auth = username && password ? { username, password } : undefined;
const workerApiRoot = (import.meta.env.VITE_WORKER_API as string | undefined)?.trim().replace(/\/+$/, '');
const useProxy = ((import.meta.env.VITE_OHIF_USE_PROXY as string | undefined) ?? '').toLowerCase() === 'true';

const rq = axios.create({
  baseURL: base,
  auth,
  timeout: 30000,
  headers: {
    Accept: "application/json",
  },
});

export type OrthancId = string;

// /patients -> [orthancPatientId, ...]
function requireRequestId(requestId?: string): string {
  const trimmed = (requestId ?? "").trim();
  if (!trimmed) {
    throw new Error("requestId is required");
  }
  return trimmed;
}

export async function listPatientIds(requestId: string): Promise<OrthancId[]> {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    console.debug("[Orthanc] axios baseURL", rq.defaults.baseURL, "requestId", requestId);
  }

  const { data } = await rq.get<OrthancId[]>("patients", { params: { requestId: requireRequestId(requestId) } });
  if (!Array.isArray(data)) {
    throw new Error(`Orthanc patients response was not an array: ${JSON.stringify(data).slice(0, 120)}`);
  }
  return data;
}

// /patients/{id} -> 詳細（MainDicomTags, Studiesなど）
export async function getPatientDetail(patientOrthancId: OrthancId, requestId: string) {
  const { data } = await rq.get(`patients/${patientOrthancId}`, {
    params: { requestId: requireRequestId(requestId) },
  });
  return data as { MainDicomTags: any; Studies: OrthancId[] };
}

// /studies/{id} -> StudyInstanceUID など
export async function getStudyDetail(studyOrthancId: OrthancId, requestId: string) {
  const { data } = await rq.get(`studies/${studyOrthancId}`, {
    params: { requestId: requireRequestId(requestId) },
  });
  return data as { MainDicomTags: any };
}

export function ohifUrlForStudyUID(studyInstanceUID: string, requestId: string) {
  const reqId = requireRequestId(requestId);
  const ohif = (import.meta.env.VITE_OHIF_URL as string) || "http://localhost:3000";
  const dicomwebEnv = import.meta.env.VITE_RQ_DICOMWEB as string | undefined;
  if (useProxy && workerApiRoot) {
    const configUrl = `${workerApiRoot}/dicom-web-config?requestId=${encodeURIComponent(reqId)}`;
    const viewerProxyBase = `${ohif.replace(/\/+$/, "")}/viewer/dicomwebproxy`;
    const params = new URLSearchParams();
    params.set("url", configUrl);
    params.set("StudyInstanceUIDs", studyInstanceUID);
    return `${viewerProxyBase}?${params.toString()}`;
  }

  let dicomwebWithId: string;
  if (dicomwebEnv && dicomwebEnv.includes("{requestId}")) {
    dicomwebWithId = dicomwebEnv.replace(/\{requestId\}/g, encodeURIComponent(reqId));
  } else if (dicomwebEnv && dicomwebEnv.includes("?")) {
    const needsAmpersand = /[?&]$/.test(dicomwebEnv) ? "" : "&";
    dicomwebWithId = `${dicomwebEnv}${needsAmpersand}requestId=${encodeURIComponent(reqId)}`;
  } else {
    const baseRoot = (dicomwebEnv ?? base).replace(/\/+$/, "");
    dicomwebWithId = `${baseRoot}/${encodeURIComponent(reqId)}/dicom-web`;
  }

  const params = new URLSearchParams();
  params.set("dicomweb", dicomwebWithId);
  const user = username || "orthanc";
  const pass = password || "orthanc";
  params.set("dicomwebUser", user);
  params.set("dicomwebPass", pass);
  params.set("StudyInstanceUIDs", studyInstanceUID);
  return `${ohif}/?${params.toString()}`;
}
