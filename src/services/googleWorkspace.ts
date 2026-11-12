import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

let isSigningIn = false;
// In-memory access token cache (never stored in localStorage/sessionStorage per security rules)
let cachedAccessToken: string | null = null;

export interface DriveColabFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  webViewLink?: string;
  colabUrl: string;
}

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Không lấy được OAuth access token từ Google Auth.');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logoutGoogle = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

export async function listColabFilesFromDrive(): Promise<DriveColabFile[]> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('NO_ACCESS_TOKEN');
  }

  const query = encodeURIComponent("trashed = false");
  const fields = encodeURIComponent('files(id,name,mimeType,createdTime,webViewLink)');
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=20&orderBy=createdTime desc&fields=${fields}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const files = Array.isArray(data.files) ? data.files : [];
  return files.map((f: any) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    createdTime: f.createdTime,
    webViewLink: f.webViewLink,
    colabUrl: `https://colab.research.google.com/drive/${f.id}`,
  }));
}

export async function uploadColabNotebookToDrive(
  filename: string,
  notebookJson: string
): Promise<DriveColabFile> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('NO_ACCESS_TOKEN');
  }

  const metadata = {
    name: filename.endsWith('.ipynb') ? filename : `${filename}.ipynb`,
    mimeType: 'application/vnd.google.colaboratory',
    description:
      'FastVideo/FastWan2.1-T2V-1.3B-Diffusers Worker Notebook managed by Hub_Provider Studio',
  };

  const boundary = '-------FastWanColabBoundary749281';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/x-ipynb+json; charset=UTF-8\r\n\r\n' +
    notebookJson +
    closeDelimiter;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,createdTime,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload notebook thất bại (${res.status}): ${errText}`);
  }

  const f = await res.json();
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    createdTime: f.createdTime,
    webViewLink: f.webViewLink,
    colabUrl: `https://colab.research.google.com/drive/${f.id}`,
  };
}

export async function deleteDriveFileById(fileId: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('NO_ACCESS_TOKEN');
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Xóa file trên Drive thất bại (${res.status}): ${errText}`);
  }
}
