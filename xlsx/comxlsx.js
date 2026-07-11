const xlsx = require("xlsx");
const path = require("path");

function readXlsxFile(relativePath) {
  try {
    const filePath = path.resolve(__dirname, "..", relativePath);
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    return data;
  } catch (error) {
    console.error(
      `❌ Error reading XLSX file at ${relativePath}:`,
      error.message,
    );
    return [];
  }
}

module.exports = readXlsxFile;
