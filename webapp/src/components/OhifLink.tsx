// 例: webapp/src/components/OhifLink.tsx
export function OhifLink({ studyInstanceUID }: { studyInstanceUID: string }) {
  const ohif = "http://localhost:3000";               // dockerのOHIF
  const dicomweb = "http://localhost:8043/dicom-web"; // Requester Orthanc
  const href = `${ohif}/?url=${encodeURIComponent(dicomweb)}&StudyInstanceUIDs=${encodeURIComponent(studyInstanceUID)}`;
  return (
    <a className="underline text-blue-600" href={href} target="_blank" rel="noreferrer">
      OHIFで開く
    </a>
  );
}
