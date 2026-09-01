import { createSignal } from "solid-js";
import env from "./env";
import { createProgressHandler } from "@/chat-api/services/Request";

export const [googleApiInitialized, setGoogleApiInitialized] =
  createSignal(false);

let initializing = false;
export const initializeGoogleDrive = (accessToken?: string) =>
  new Promise<void>((res) => {
    if (googleApiInitialized()) return;
    if (initializing) return;
    initializing = true;
    const start = async () => {
      await gapi.client.init({
        apiKey: env.GOOGLE_API_KEY,
        discoveryDocs: [
          "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"
        ],
        clientId: env.GOOGLE_CLIENT_ID
      });
      accessToken && gapi.client.setToken({ access_token: accessToken });
      initializing = false;
      setGoogleApiInitialized(true);
      res();
    };
    gapi.load("client", start);
  });

let ruginUploadsFolder: gapi.client.drive.File | undefined;

export const getOrCreateUploadsFolder = async (accessToken: string) => {
  if (ruginUploadsFolder) return ruginUploadsFolder;
  if (!googleApiInitialized()) await initializeGoogleDrive(accessToken);
  const res = await gapi.client.drive.files.list({
    q: "name = 'rugin_uploads' and mimeType = 'application/vnd.google-apps.folder'",
    fields: "files(id)"
  });
  const folder = res.result.files?.[0];
  if (folder) {
    ruginUploadsFolder = folder;
    return ruginUploadsFolder;
  }

  const newFolder = await gapi.client.drive.files.create({
    resource: {
      name: "rugin_uploads",
      mimeType: "application/vnd.google-apps.folder"
    },
    fields: "id"
  });
  ruginUploadsFolder = newFolder.result;
  return ruginUploadsFolder;
};

// https://stackoverflow.com/questions/53839499/google-drive-api-and-file-uploads-from-the-browser
export const uploadFileGoogleDrive = async (
  file: File,
  accessToken: string,
  onProgress?: (percent: number, speed?: string) => void
) => {
  if (!googleApiInitialized()) await initializeGoogleDrive(accessToken);
  gapi.client.setToken({ access_token: accessToken });
  const folder = await getOrCreateUploadsFolder(accessToken);
  const metadata = {
    name: file.name,
    mimeType: file.type,
    parents: [folder.id!]
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append("file", file);

  const xhr = new XMLHttpRequest();
  xhr.open(
    "post",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,kind"
  );
  xhr.setRequestHeader("Authorization", "Bearer " + accessToken);
  xhr.responseType = "json";

  const progressHandler = createProgressHandler(onProgress);
  xhr.upload.onprogress = (e) => {
    progressHandler(e);
  };

  return new Promise<{ id: string }>((resolve, reject) => {
    xhr.onload = async () => {
      if (xhr.status === 0) {
        return reject({ message: "Could not connect to server." });
      }
      if (xhr.status !== 200) {
        ruginUploadsFolder = undefined;
        return reject(xhr.response);
      }
      const id = xhr.response.id;

      const body = {
        value: "default",
        type: "anyone",
        role: "reader"
      };

      await gapi.client.drive.permissions.create({
        fileId: id,
        resource: body
      });
      resolve(xhr.response);
    };
    xhr.send(form);
  });
};

export const getFile = async (fileId: string, fields?: string) => {
  const res = await gapi.client.drive.files.get({
    fileId: fileId,
    fields: fields || "*"
  });
  return res.result;
};

/**
 * Reads metadata for a *publicly shared* file via a plain REST call, using
 * only the API key — no gapi/OAuth session needed. Attachments are shared
 * with "anyone with the link", so any viewer should be able to see them
 * regardless of whether they've personally linked Google Drive; routing
 * this through gapi's OAuth-aware client made it depend on a session that
 * only the uploader (and anyone who happened to already be signed in)
 * actually had, so everyone else saw "couldn't get file".
 */
export const getPublicFile = async (
  fileId: string,
  fields = "name,size,modifiedTime,webContentLink,mimeType,thumbnailLink"
): Promise<gapi.client.drive.File | null> => {
  if (!env.GOOGLE_API_KEY) return null;
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${fileId}`
  );
  url.searchParams.set("key", env.GOOGLE_API_KEY);
  url.searchParams.set("fields", fields);
  const res = await fetch(url.toString()).catch(() => undefined);
  if (!res || !res.ok) return null;
  return res.json();
};
