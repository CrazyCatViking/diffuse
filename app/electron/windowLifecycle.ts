export type WindowCloseDisposition = 'close' | 'hide' | 'quit';

export function windowCloseDisposition(isQuitting: boolean, hasTray: boolean): WindowCloseDisposition {
  if (isQuitting) return 'close';
  return hasTray ? 'hide' : 'quit';
}
