const https = require('https');
const fs = require('fs');

const url = "https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/tuolit-jakkarat/oppilastuolit/matte/muoviristikko-pyorilla-4955-599163/matte-fsc-tuoli-kaasujousella-iso-istuin/";

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        fs.writeFileSync('page.html', data);
        console.log('Page saved to page.html');
    });
}).on('error', (err) => {
    console.error('Error: ' + err.message);
});
