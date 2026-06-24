export type Carrier = 'econt' | 'speedy';
export type DeliveryMode = 'office' | 'address';
export type RowStatus = 'ok' | 'warn' | 'error';

/** A raw parsed row: header → cell value (string after parse). */
export interface RawRow {
  [header: string]: string;
}

/** Per-batch defaults applied to blank cells. */
export interface BatchDefaults {
  carrier: Carrier;
  currency: 'BGN' | 'EUR';
  weightGrams?: number;
  contents?: string;
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';
  speedyServiceId?: number;
}

/** A row after header-mapping + typing + defaults. Money already in stotinki. */
export interface NormalizedRow {
  rowIndex: number;
  receiverName: string;
  receiverPhone: string;
  deliveryMode: DeliveryMode | null;
  city: string | null;
  office: string | null;
  address: string | null;
  streetNo: string | null;
  weightGrams: number | null;
  contents: string | null;
  codAmountStotinki: number | null;
  declaredValueStotinki: number | null;
  carrier: Carrier;
  raw: RawRow;
}

export interface RowIssue {
  field: string;
  message: string;
  suggestion?: string;
}

export interface RowValidation {
  status: RowStatus;
  issues: RowIssue[];
}

/** One row's AI verdict from OpenAI. */
export interface AiVerdict {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  normalized?: Partial<NormalizedRow>;
}
