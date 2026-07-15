const dns = require("dns");

dns.resolveSrv("_mongodb._tcp.cluster0.mmszeat.mongodb.net", (err, records) => {
    if (err) {
        console.error(err);
    } else {
        console.log(records);
    }
});