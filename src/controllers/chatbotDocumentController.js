
const { PDFParse } = require('pdf-parse');
const { pool } = require('../config/db');

const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 180;

function splitDocumentIntoChunks(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('. ', end);
      if (boundary > start + CHUNK_SIZE * 0.6) end = boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

const uploadDocument = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      message: 'Please select a PDF file.',
    });
  }

const { originalname, buffer } = req.file;
const mimetype = 'application/pdf';

  // Verify the actual PDF signature.
const pdfHeader = buffer
  .subarray(0, 1024)
  .toString('latin1');

const hasPdfSignature = pdfHeader.includes('%PDF-');

console.log('Uploaded file:', originalname);
console.log('MIME type:', mimetype);
console.log('PDF signature found:', hasPdfSignature);

if (!hasPdfSignature) {
  return res.status(400).json({
    message: 'The uploaded file is not a valid PDF.',
  });
}

  let parser;

  try {
    parser = new PDFParse({ data: buffer });

    const result = await parser.getText();
    const extractedText = (result.text || '').trim();

    if (!extractedText) {
      return res.status(400).json({
        message:
          'No readable text found. Scanned PDFs require OCR.',
      });
    }

    const chunks = splitDocumentIntoChunks(extractedText);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const saved = await client.query(`
        INSERT INTO hcm.chatbot_documents
          (file_name, file_type, file_data, extracted_text)
        VALUES ($1, $2, $3, $4)
        RETURNING id, file_name, file_type, uploaded_at
      `, [originalname, mimetype, buffer, extractedText]);

      for (const [index, chunk] of chunks.entries()) {
        await client.query(`
          INSERT INTO hcm.chatbot_document_chunks (document_id, chunk_index, chunk_text)
          VALUES ($1, $2, $3)
        `, [saved.rows[0].id, index, chunk]);
      }

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Document uploaded successfully.',
        document: saved.rows[0],
        indexedChunks: chunks.length,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Chatbot document upload failed:', error);

    return res.status(500).json({
      message: 'Unable to process the document.',
    });
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }
};

const listDocuments = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, file_name, file_type, uploaded_at
      FROM hcm.chatbot_documents
      ORDER BY uploaded_at DESC
    `);

    return res.json({ documents: result.rows });
  } catch (error) {
    console.error('Failed to list chatbot documents:', error);

    return res.status(500).json({
      message: 'Unable to retrieve documents.',
    });
  }
};

module.exports = {
  uploadDocument,
  listDocuments,
};
