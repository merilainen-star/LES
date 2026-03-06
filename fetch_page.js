const https = require('https');
const fs = require('fs');

const url = "https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/tuolit-jakkarat/oppilastuolit/?page=2";

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
