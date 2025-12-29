import axios from "axios";


export async function listStudiesByPatient(qidoBase: string, patientId: string, issuer?: string) {
const url = `${qidoBase}/studies`;
const params: any = { PatientID: patientId };
if (issuer) params.IssuerOfPatientID = issuer;
const { data } = await axios.get(url, { params });
return data; // QIDO-RS JSON
}


export async function listSeries(qidoBase: string, studyInstanceUID: string) {
const { data } = await axios.get(`${qidoBase}/studies/${studyInstanceUID}/series`);
return data;
}


export async function listInstances(qidoBase: string, studyUID: string, seriesUID: string) {
const { data } = await axios.get(`${qidoBase}/studies/${studyUID}/series/${seriesUID}/instances`);
return data;
}


export async function fetchInstanceWado(wadoBase: string, studyUID: string, seriesUID: string, sopUID: string) {
const url = `${wadoBase}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}`;
const { data } = await axios.get(url, { responseType: "arraybuffer" });
return Buffer.from(data);
}


export async function postToOrthanc(orthancBase: string, auth: { username: string, password: string }, dcm: Buffer) {
const url = `${orthancBase}/instances`;
await axios.post(url, dcm, {
auth,
headers: { "Content-Type": "application/dicom" }
});
}