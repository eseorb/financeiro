export enum FileStatus {
  IDLE = 'idle',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  ERROR = 'error'
}

export interface ExtractedData {
  beneficiary: string;
  value: string;
  dueDate: string;
  paymentDate: string;
}

export interface ProcessedFile {
  id: string;
  file: File;
  status: FileStatus;
  progress: number;
  error?: string;
  extractedData?: ExtractedData;
  newName?: string;
  blob?: Blob;
}
