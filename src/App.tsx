/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { 
  Upload, 
  FileText, 
  Play, 
  XCircle, 
  Download, 
  CheckCircle2, 
  AlertCircle, 
  Loader2,
  Trash2,
  FileArchive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import Tesseract from 'tesseract.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { FileStatus, ProcessedFile, ExtractedData } from './types';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = {
    total: files.length,
    processed: files.filter(f => f.status === FileStatus.COMPLETED).length,
    errors: files.filter(f => f.status === FileStatus.ERROR).length,
    processing: files.filter(f => f.status === FileStatus.PROCESSING).length,
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent) => {
    let uploadedFiles: File[] = [];
    if ('files' in e.target && e.target.files) {
      uploadedFiles = Array.from(e.target.files);
    } else if ('dataTransfer' in e && e.dataTransfer.files) {
      uploadedFiles = Array.from(e.dataTransfer.files);
    }

    const pdfFiles = uploadedFiles.filter(file => file.type === 'application/pdf');
    
    const newProcessedFiles: ProcessedFile[] = pdfFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      status: FileStatus.IDLE,
      progress: 0
    }));

    setFiles(prev => [...prev, ...newProcessedFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearFiles = () => {
    setFiles([]);
  };

  const abortProcess = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessing(false);
    setShowProgressModal(false);
    clearFiles();
  };

  const extractDataFromText = (text: string): ExtractedData => {
    // Normalize text: uppercase and remove extra spaces
    const cleanText = text.toUpperCase().replace(/\s+/g, ' ');

    // Regex patterns for Brazilian bank receipts
    // Improved beneficiary regex to prioritize receiver terms and avoid payer terms
    const beneficiaryRegex = /(?:BENEFICIÁRIO|FAVORECIDO|RECEBEDOR|CREDITADO|NOME DO FAVORECIDO)[:\s]+([^0-9\n]{3,60})/i;
    const valueRegex = /(?:VALOR|TOTAL|PAGO|DOCUMENTO|R\$)\s*[:\s]*R?\$\s*([\d.,]+)/i;
    const dateRegex = /(\d{2}\/\d{2}\/\d{4})/g;

    // Try to find beneficiary specifically
    let beneficiaryMatch = cleanText.match(beneficiaryRegex);
    
    // If not found, try a more generic one but avoid "PAGADOR"
    if (!beneficiaryMatch) {
      const genericNameRegex = /(?:NOME)[:\s]+([^0-9\n]{3,60})/gi;
      let match;
      while ((match = genericNameRegex.exec(cleanText)) !== null) {
        const context = cleanText.substring(Math.max(0, match.index - 20), match.index);
        if (!context.includes('PAGADOR') && !context.includes('DEBITADO')) {
          beneficiaryMatch = match;
          break;
        }
      }
    }

    const valueMatch = cleanText.match(valueRegex);
    const dates = cleanText.match(dateRegex) || [];

    // Heuristics for dates
    // Usually Vencimento comes before Pagamento or is explicitly labeled
    let dueDate = '';
    let paymentDate = '';

    if (dates.length >= 2) {
      dueDate = dates[0];
      paymentDate = dates[1];
    } else if (dates.length === 1) {
      dueDate = dates[0];
      paymentDate = dates[0];
    }

    // Refine beneficiary (clean up common suffixes and ensure uppercase)
    let beneficiary = beneficiaryMatch ? beneficiaryMatch[1].trim().toUpperCase() : 'DESCONHECIDO';
    
    // List of labels and noise to remove from the extracted name
    const noiseToRemove = [
      'NOME DO RECEBEDOR', 'NOME DO FAVORECIDO', 'NOME', 'RECEBEDOR', 'FAVORECIDO',
      'CHAVE', 'PIX', 'CPF', 'CNPJ', 'CONTA', 'AGÊNCIA', 'AGENCIA', 'BANCO', 'INSTITUIÇÃO'
    ];

    // Remove labels from the beginning
    noiseToRemove.forEach(noise => {
      if (beneficiary.startsWith(noise)) {
        beneficiary = beneficiary.substring(noise.length).trim();
      }
    });

    // Remove noise from the end and split by common delimiters
    beneficiary = beneficiary
      .split(' CPF')[0]
      .split(' CNPJ')[0]
      .split(' CHAVE')[0]
      .split(' PIX')[0]
      .split(' -')[0]
      .replace(/[:]/g, '')
      .trim();

    // Final check for leading/trailing non-alphanumeric noise (like + or -)
    beneficiary = beneficiary.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '').trim();

    return {
      beneficiary: beneficiary || 'DESCONHECIDO',
      value: valueMatch ? valueMatch[1].replace('R$', '').trim() : '0,00',
      dueDate: dueDate || '00/00/0000',
      paymentDate: paymentDate || '00/00/0000'
    };
  };

  const formatDateForFilename = (dateStr: string) => {
    if (!dateStr || dateStr === '00/00/0000') return '00000000';
    const [day, month, year] = dateStr.split('/');
    return `${year}${month}${day}`;
  };

  const sanitizeFilename = (name: string) => {
    return name.replace(/[<>:"/\\|?*]/g, '').trim();
  };

  const processFile = async (processedFile: ProcessedFile, signal: AbortSignal) => {
    try {
      setFiles(prev => prev.map(f => f.id === processedFile.id ? { ...f, status: FileStatus.PROCESSING, progress: 10 } : f));

      const arrayBuffer = await processedFile.file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        if (signal.aborted) throw new Error('Aborted');
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + ' ';
      }

      // If text is too short, try OCR
      if (fullText.trim().length < 50) {
        setFiles(prev => prev.map(f => f.id === processedFile.id ? { ...f, progress: 30 } : f));
        
        // Render first page to canvas for OCR
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
          await page.render({ canvasContext: context, viewport, canvas }).promise;
          const { data: { text } } = await Tesseract.recognize(canvas, 'por', {
            logger: m => console.log(m)
          });
          fullText = text;
        }
      }

      if (signal.aborted) throw new Error('Aborted');

      const data = extractDataFromText(fullText);
      
      const newName = sanitizeFilename(`${data.beneficiary} - R$ ${data.value}.pdf`);

      setFiles(prev => prev.map(f => f.id === processedFile.id ? { 
        ...f, 
        status: FileStatus.COMPLETED, 
        progress: 100,
        extractedData: data,
        newName,
        blob: processedFile.file
      } : f));

    } catch (error: any) {
      if (error.message === 'Aborted') return;
      console.error(error);
      setFiles(prev => prev.map(f => f.id === processedFile.id ? { 
        ...f, 
        status: FileStatus.ERROR, 
        error: error.message || 'Erro ao processar PDF' 
      } : f));
    }
  };

  const startProcessing = async () => {
    setIsProcessing(true);
    setShowProgressModal(true);
    abortControllerRef.current = new AbortController();

    const filesToProcess = files.filter(f => f.status === FileStatus.IDLE || f.status === FileStatus.ERROR);
    
    for (const file of filesToProcess) {
      if (abortControllerRef.current.signal.aborted) break;
      await processFile(file, abortControllerRef.current.signal);
    }

    setIsProcessing(false);
  };

  const downloadSingle = (file: ProcessedFile) => {
    if (file.newName) {
      saveAs(file.file, file.newName);
    }
  };

  const downloadAll = async () => {
    const zip = new JSZip();
    const completedFiles = files.filter(f => f.status === FileStatus.COMPLETED && f.newName);
    
    if (completedFiles.length === 0) return;

    completedFiles.forEach(f => {
      zip.file(f.newName!, f.file);
    });

    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, `comprovantes_processados_${new Date().getTime()}.zip`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 md:p-8 selection:bg-emerald-500/30">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">AutomatizadorComprovante</h1>
            <p className="text-slate-400">Automação de processamento e renomeação de comprovantes</p>
          </div>
          <div className="flex gap-2">
            {files.length > 0 && !isProcessing && (
              <button 
                onClick={() => setShowClearConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-800 text-slate-400 hover:bg-slate-900 hover:text-white transition-all text-sm font-medium"
              >
                <Trash2 size={18} />
                Limpar Lista
              </button>
            )}
          </div>
        </header>

        {/* Clear Confirmation Modal */}
        <AnimatePresence>
          {showClearConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6"
              >
                <h3 className="text-lg font-bold mb-2 text-white">Limpar Lista?</h3>
                <p className="text-slate-400 mb-6">
                  Você tem certeza que deseja excluir todos os comprovantes da lista? Esta ação não pode ser desfeita.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setShowClearConfirm(false)}
                    className="flex-1 px-4 py-2 rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                  >
                    Cancelar
                  </button>
                  <button 
                    onClick={() => {
                      clearFiles();
                      setShowClearConfirm(false);
                    }}
                    className="flex-1 px-4 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition-colors font-medium"
                  >
                    Sim, Limpar
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Main Content */}
        <main className="grid grid-cols-1 gap-8">
          {/* Upload Area */}
          <section 
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFileUpload(e);
            }}
            className="relative group"
          >
            <input 
              type="file" 
              multiple 
              accept=".pdf" 
              onChange={handleFileUpload} 
              className="hidden" 
              ref={fileInputRef}
            />
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-800 rounded-2xl p-12 flex flex-col items-center justify-center gap-4 bg-slate-900/30 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all cursor-pointer group"
            >
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500 group-hover:scale-110 transition-transform">
                <Upload size={32} />
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold text-white">Arraste seus PDFs aqui</p>
                <p className="text-slate-400">ou clique para selecionar arquivos do seu computador</p>
              </div>
              <p className="text-xs text-slate-500 uppercase tracking-widest font-bold">Apenas arquivos PDF</p>
            </div>
          </section>

          {/* Action Bar */}
          {files.length > 0 && (
            <section className="flex flex-wrap items-center justify-between gap-4 bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-xl">
              <div className="flex items-center gap-6">
                <div className="flex flex-col">
                  <span className="text-xs text-slate-500 uppercase font-bold tracking-tighter">Total</span>
                  <span className="text-xl font-bold text-white">{stats.total}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-slate-500 uppercase font-bold tracking-tighter">Concluídos</span>
                  <span className="text-xl font-bold text-emerald-500">{stats.processed}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-slate-500 uppercase font-bold tracking-tighter">Erros</span>
                  <span className="text-xl font-bold text-rose-500">{stats.errors}</span>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  disabled={isProcessing || stats.total === 0}
                  onClick={startProcessing}
                  className="flex items-center gap-2 bg-white text-slate-950 px-6 py-2.5 rounded-lg hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold"
                >
                  <Play size={18} fill="currentColor" />
                  Iniciar Processamento
                </button>
                
                {stats.processed > 0 && (
                  <button
                    onClick={downloadAll}
                    className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-2.5 rounded-lg hover:bg-emerald-700 transition-all font-bold shadow-lg shadow-emerald-900/20"
                  >
                    <FileArchive size={18} />
                    Baixar Todos (ZIP)
                  </button>
                )}
              </div>
            </section>
          )}

          {/* File List */}
          <section className="space-y-3">
            <AnimatePresence mode="popLayout">
              {files.map((file) => (
                <motion.div
                  key={file.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between group hover:border-slate-700 hover:bg-slate-800/50 transition-all"
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      file.status === FileStatus.COMPLETED ? 'bg-emerald-500/10 text-emerald-500' :
                      file.status === FileStatus.ERROR ? 'bg-rose-500/10 text-rose-500' :
                      file.status === FileStatus.PROCESSING ? 'bg-blue-500/10 text-blue-500' :
                      'bg-slate-800 text-slate-500'
                    }`}>
                      {file.status === FileStatus.PROCESSING ? <Loader2 className="animate-spin" size={20} /> : <FileText size={20} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate text-slate-100">
                        {file.newName || file.file.name}
                      </p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-slate-500">{(file.file.size / 1024).toFixed(1)} KB</span>
                        {file.status === FileStatus.ERROR && (
                          <span className="text-xs text-rose-500 flex items-center gap-1 font-medium">
                            <AlertCircle size={12} />
                            {file.error}
                          </span>
                        )}
                        {file.status === FileStatus.COMPLETED && (
                          <span className="text-xs text-emerald-500 flex items-center gap-1 font-medium">
                            <CheckCircle2 size={12} />
                            Processado com sucesso
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 ml-4">
                    {file.status === FileStatus.COMPLETED && (
                      <button 
                        onClick={() => downloadSingle(file)}
                        className="p-2 rounded-lg hover:bg-emerald-500/10 text-emerald-500 transition-colors"
                        title="Baixar arquivo renomeado"
                      >
                        <Download size={20} />
                      </button>
                    )}
                    {!isProcessing && (
                      <button 
                        onClick={() => removeFile(file.id)}
                        className="p-2 rounded-lg hover:bg-rose-500/10 text-slate-500 hover:text-rose-500 transition-colors"
                        title="Remover da lista"
                      >
                        <Trash2 size={20} />
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {files.length === 0 && (
              <div className="text-center py-20 bg-slate-900/20 rounded-2xl border-2 border-dashed border-slate-800">
                <p className="text-slate-500">Nenhum arquivo carregado ainda.</p>
              </div>
            )}
          </section>
        </main>

        {/* Progress Modal */}
        <AnimatePresence>
          {showProgressModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-8"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-white">Processando Arquivos</h3>
                  {isProcessing ? (
                    <Loader2 className="animate-spin text-slate-500" size={24} />
                  ) : (
                    <CheckCircle2 className="text-emerald-500" size={24} />
                  )}
                </div>

                <div className="space-y-6">
                  <div className="flex justify-between text-sm font-medium">
                    <span className="text-slate-400">Progresso Geral</span>
                    <span className="text-white">{stats.processed + stats.errors} / {stats.total}</span>
                  </div>
                  
                  <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                      initial={{ width: 0 }}
                      animate={{ width: `${((stats.processed + stats.errors) / stats.total) * 100}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-800">
                      <p className="text-xs text-slate-500 uppercase font-bold mb-1">Total</p>
                      <p className="text-xl font-bold text-white">{stats.total}</p>
                    </div>
                    <div className="bg-emerald-500/5 p-3 rounded-xl border border-emerald-500/10">
                      <p className="text-xs text-emerald-500 uppercase font-bold mb-1">Sucesso</p>
                      <p className="text-xl font-bold text-emerald-500">{stats.processed}</p>
                    </div>
                    <div className="bg-rose-500/5 p-3 rounded-xl border border-rose-500/10">
                      <p className="text-xs text-rose-500 uppercase font-bold mb-1">Erro</p>
                      <p className="text-xl font-bold text-rose-500">{stats.errors}</p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 pt-4">
                    {isProcessing ? (
                      <button 
                        onClick={abortProcess}
                        className="w-full flex items-center justify-center gap-2 bg-rose-600 text-white py-3 rounded-xl hover:bg-rose-700 transition-all font-bold"
                      >
                        <XCircle size={20} />
                        Abortar Processo
                      </button>
                    ) : (
                      <button 
                        onClick={() => setShowProgressModal(false)}
                        className="w-full bg-white text-slate-950 py-3 rounded-xl hover:bg-slate-200 transition-all font-bold"
                      >
                        Fechar e Ver Resultados
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
