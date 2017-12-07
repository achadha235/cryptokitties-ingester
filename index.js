const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, 'data');
const child_process = require('child_process');
const cores  = require('os').cpus().length;
const cluster = require('cluster');
const winston = require('winston');
const AWS = require('aws-sdk');

let bucketName = process.env.BUCKET || 'deepkitty';
s3 = undefined;

async function getKittyGenome(startKitty, stopKitty){
	const browser = await puppeteer.launch();
	let maxKitty = stopKitty;
	for (let currKitty = startKitty; currKitty < maxKitty; currKitty++) {

		try {
			const kittyGenomeExists = await checkKittyGenomeExists(currKitty);

			if (!kittyGenomeExists){
				const page = await browser.newPage();	
				page.setViewport({ height: 1200, width: 1800})
				page.on('response', async (response) => {
					if (response.request().url.indexOf('.svg') > 0) { 
						saveFile(`${currKitty}.svg`, (await response.buffer()))					
					} else if (response.request().url.indexOf('.png') > 0) { 
						saveFile(`${currKitty}.png`, (await response.buffer()));					
					} 
				});
				await page.goto(`https://cryptokittydex.com/kitties/${currKitty}`, { waitUntil: 'networkidle2' });
				await page.content();
				let result = await page.evaluate(() => {
					const owner = document.querySelector('.list-unstyled').children[0].children[0].innerHTML;
					const gen = document.querySelector('.list-unstyled').children[2].children[0].innerHTML;
					const genesList = document.querySelector('.list-unstyled').querySelector('ul').children;
					let genes = '0x';
					for (var i = 0; i < genesList.length; i++) { genes =  genes + genesList[i].children[0].innerHTML; }
					return { owner, genes, gen };
				}); 
				winston.info(currKitty, result);
				saveFile(`${currKitty}.json`, new Buffer(JSON.stringify(result, null, '\t'), 'binary'))
				page.close();
			} else {
				winston.info(`Kitty #${currKitty} already exists`);
			}
		} catch (e) {
			console.error(e);
		}
	}
	await browser.close();
}

function getRanges(startKitty, endKitty, cores) {
	const ranges = [];
	const stride = Math.floor((endKitty - startKitty) / cores);
	let curr = startKitty;
	for (let i = 0; i < cores; i++) {
		if (i === cores - 1) {
			ranges.push([curr, endKitty]);
		} else {
			ranges.push([curr, curr + stride]);
			curr = curr + stride;
		}
	}
	return ranges;
}

async function main() {
	if (cluster.isMaster) {
		winston.info('No of cores:' + cores);

		if (process.env.NODE_ENV !== 'production' && !fs.existsSync(dataDir)){
			fs.mkdirSync(dataDir);
		}
		const startKitty = parseInt(process.env.START) || 1 ;
		const endKitty = parseInt(process.env.STOP) || 100000;
		const ranges = getRanges(startKitty, endKitty, cores);
		for (var i = 0; i < cores; i++){
			cluster.fork({
				NODE_ENV: process.env.NODE_ENV,
				START_KITTY: ranges[i][0],
				END_KITTY: ranges[i][1]
			});
		}
		cluster.on('exit', (worker, code, signal) => {
			winston.info(`Worker ${worker.process.pid} died`);
		});
	} else {

		if (process.env.NODE_ENV === 'production') {
			AWS.config.update({ accessKeyId: process.env.AWS_KEY, secretAccessKey: process.env.AWS_SECRET });
			s3 = new AWS.S3();
		}
		const s = process.env.START_KITTY;
		const e = process.env.END_KITTY;
		winston.info(`Worker ${process.pid} started fetching genome for Kitty #${s} - #${e}`);
		await getKittyGenome(s, e);
	}
}

function saveFile(fileName, buffer) {
	if (process.env.NODE_ENV === 'production') {
		s3.putObject({
			Bucket: bucketName,
			Key: fileName,
			Body: buffer,
			ACL: 'public-read'
		}, (resp) => {
			winston.info(`Successfully uploaded ${fileName}`);
		});
	} else {
		fs.writeFileSync(path.join(dataDir,fileName), buffer);
		winston.info('Successfully saved file.');
	}
}

async function checkKittyGenomeExists(kittyId) {
	return new Promise((resolve, reject) => {
		if (process.env.NODE_ENV === 'production') {
			s3.headObject({
				Bucket: bucketName,
				Key: `${kittyId}.json`
			}, function (err, metadata) {  
				if (err && err.code === 'NotFound') {  
					resolve(false);
				} else {  
					resolve(true);
				}
			});
		} else {
			resolve(fs.existsSync(path.join(dataDir,fileName)));
		}
	})
}

main()
.then(() => {
	winston.info('Done');
})