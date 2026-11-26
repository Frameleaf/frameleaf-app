import { getPrintBack, updatePrintBack, type AssetResponseDto, type PrintBackResponseDto } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import type { PrintPair } from '$lib/frameleaf/print-pairs';
import AddPrintBackSheet from '$lib/modals/AddPrintBackSheet.svelte';
import PrintBackPairSheet from '$lib/modals/PrintBackPairSheet.svelte';

/** Bumped when a pair changes, so an open Information panel reads the back again. */
export const printBackChanges = $state({ revision: 0 });

export const readPrintBack = (id: string): Promise<PrintBackResponseDto> => getPrintBack({ id });

export const setPrintBack = async (id: string, backAssetId: string | null): Promise<PrintBackResponseDto> => {
  const result = await updatePrintBack({ id, printBackUpdateDto: { backAssetId } });
  printBackChanges.revision++;
  return result;
};

/** The review sheet for a batch that alternates front, back. */
export const openPrintPairs = async (pairs: PrintPair[]) => {
  const count: number | undefined = await modalManager.show(PrintBackPairSheet, { pairs });
  if (count) {
    toastManager.primary(get(t)('frameleaf_print_back_paired', { values: { count } }));
  }
};

/** "Add back of print" on one photo. */
export const openAddPrintBack = async (asset: AssetResponseDto) => {
  const added: boolean | undefined = await modalManager.show(AddPrintBackSheet, { asset });
  if (added) {
    toastManager.primary(get(t)('frameleaf_print_back_added'));
  }
};
