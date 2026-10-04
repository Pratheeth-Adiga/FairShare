/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_P2P_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
