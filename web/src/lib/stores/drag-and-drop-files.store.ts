import { getContext, setContext } from 'svelte';

type DropHandler = (files: File[]) => void;

export const createDropUploadChannel = () => {
  let handler: { receive: DropHandler } | undefined;
  return {
    register(receive: DropHandler) {
      const owner = { receive };
      handler = owner;
      return () => {
        if (handler === owner) {
          handler = undefined;
        }
      };
    },
    capture() {
      const owner = handler;
      return (files: File[]) => {
        if (owner && handler === owner && files.length > 0) {
          owner.receive(files);
        }
      };
    },
  };
};

const contextKey = Symbol('drop-upload');
export const createDropUploadContext = () => setContext(contextKey, createDropUploadChannel());
export const getDropUploadContext = () =>
  getContext<ReturnType<typeof createDropUploadChannel> | undefined>(contextKey);
