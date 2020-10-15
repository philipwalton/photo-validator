const fs = require('fs');
const path = require('path');
const util = require('util');
const child_process = require('child_process');

const execFile = util.promisify(child_process.execFile);

// exiftool -FileName -FileType -PreservedFileName -isMergedHDR -isMergedPanorama -r -j /Volumes/LaCie/Pictures/2016 > 2016.json

const sonyFileNamePatterns = [
  [/_DSC\d{4}/, 'ARW'],
  [/_7R3\d{4}/, 'ARW'],
  [/_7R4\d{4}/, 'ARW'],
  [/DSC0\d{4}/, 'ARW'],
];

const canonFileNamePatterns = [
  [/IMG_\d{4}/, 'CR2'],
  [/1D9A\d{4}/, 'CR2'],
];

const rawPatterns = [
  ...sonyFileNamePatterns,
  ...canonFileNamePatterns,
];

const catalogDir = `/Volumes/LaCie/Pictures`;

function validateFileName(fileName) {
  const re = /^\d{8}_\d{6}_(\w{4}\d{4})(-HDR)?(-Pano)?(-Edit)?\.(dng|tif)/;
  const match = re.exec(fileName);

  if (match) {
    const originalBaseName = match[1];
    const isMergedHDR = Boolean(match[2]);
    const isMergedPanorama = Boolean(match[3]);
    const isEdit = Boolean(match[4]);
    const ext = match[5];

    for (const [p, rawExt] of rawPatterns) {
      if (p.test(originalBaseName)) {
        return {
          originalBaseName,
          rawExt,
          isMergedHDR,
          isMergedPanorama,
          isEdit,
          ext,
        }
      }
    }
  }
}

async function generateMetaData(dir) {
  return await new Promise((resolve, reject) => {
    const exiftool = child_process.spawn('exiftool', [
      `-FileName`,
      `-FileType`,
      `-PreservedFileName`,
      `-isMergedHDR`,
      `-isMergedPanorama`,
      `-r`,
      `-j`,
      path.join(catalogDir, dir),
    ]);

    let json = '';
    let error = '';

    exiftool.stdout.on('data', (data) => json += data.toString());
    exiftool.stderr.on('data', (data) => error += data.toString());

    exiftool.on('close', (code) => {
      if (code !== 0) {
        console.error(error);
        reject(new Error(`exiftool process exited with code ${code}`));
      }
      fs.writeFileSync(`./${path.basename(dir)}.json`, json);
      resolve(JSON.parse(json));
    });
  });
}

async function deleteTempFiles(year) {
  await execFile('exiftool', [
    `-delete_original!`,
    `-r`,
    path.join(catalogDir, year),
  ]);
}

async function analyzeMetadata(subDir) {
  console.log(`Reading metadata for ${subDir}...`);
  const metadata = await generateMetaData(subDir)
  console.log(`Done reading data, validating...\n`);

  for (const data of metadata) {
    const sourceFile = data.SourceFile;
    const fileName = data.FileName;
    const fileType = data.FileType;
    const isMergedHDR = data.IsMergedHDR;
    const isMergedPanorama = data.IsMergedPanorama;
    const originalDateTime = data.OriginalDateTime;
    const preservedFileName = data.PreservedFileName;

    if (!(fileType === 'DNG' || fileType === 'TIFF' || fileType === 'JPEG')) {
      throw new Error(`Unexpected FileType found: ${fileName}`);
    }

    // Ignore JPEGs
    if (fileType === 'JPEG') {
      continue;
    }

    // 1) Ensure the filename formatting is correct
    // ---------------------------------------------
    const validatedData = validateFileName(fileName);

    if (!validatedData) {
      throw new Error(`Invalid FileName format: ${fileName}`);
    }

    const {originalBaseName, ext, rawExt} = validatedData;
    const originalFileName = `${originalBaseName}.${rawExt}`;

    // 2) Ensure `PreservedFileName` is correct
    // ----------------------------------------
    if (originalFileName !== preservedFileName && fileType !== 'JPEG') {
      console.log([
        `Unexpected PreservedFileName found:`,
        preservedFileName,
        fileName
      ].join('\n  '));

      console.log(`Updating PreservedFileName for: `, sourceFile);
      await execFile('exiftool', [
        `-PreservedFileName=${originalFileName}`,
        sourceFile,
      ]);
      console.log(`Done!\n`);
    }

    // 3) Ensure `-HDR` suffix is set for HDR images
    // ---------------------------------------------
    if (isMergedHDR && !validatedData.isMergedHDR) {
      throw new Error(`HDR image found without '-HDR' suffix: ${fileName}`);
    }

    // 4) Ensure `-Pano` suffix is set for Panorama images
    // ---------------------------------------------------
    if (isMergedPanorama && !validatedData.isMergedPanorama) {
      throw new Error(`Pano image found without '-Pano' suffix: ${fileName}`);
    }

    // 5) Ensure the `-Edit` suffix is set for TIFF images
    // ---------------------------------------------------
    if (fileType === 'TIFF' && !(ext === 'tif' && validatedData.isEdit)) {
      throw new Error([
        `TIFF image found without '-Edit' suffix or 'tif' extension:`,
        fileName,
      ].join('\n'));
    }

    // TODO: ensure the filename matches the real date/time
  }

  await deleteTempFiles(subDir);
  console.log(`Done validating data for ${subDir}, SUCCESS!\n`);
}

async function main() {
  const years = ['2016', '2017', '2018', '2019', '2020'];

  for (const year of years) {
    await analyzeMetadata(year);
  }

  console.log('All validations complete!')
}

main().catch(console.error);
