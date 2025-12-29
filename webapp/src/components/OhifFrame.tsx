// 例: webapp/src/components/OhifFrame.tsx
export function OhifFrame({ url }: { url: string }) {
  return (
    <iframe src={url} style={{ width: "100%", height: "80vh", border: "0" }} />
  );
}
// 呼び出し側
const dicomweb = "http://localhost:8043/dicom-web";
const study = "<StudyInstanceUID>";
const url = `http://localhost:3000/?url=${encodeURIComponent(dicomweb)}&StudyInstanceUIDs=${study}`;
<OhifFrame url={url} />
