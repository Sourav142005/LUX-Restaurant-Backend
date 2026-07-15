const dns = require("dns");

console.log("DNS Servers:", dns.getServers());

dns.resolve4("google.com", (err, addresses) => {
    console.log("Google A Record");
    console.log(err);
    console.log(addresses);
});

dns.resolveSrv("_mongodb._tcp.cluster0.mmszeat.mongodb.net", (err, records) => {
    console.log("\nMongoDB SRV Record");
    console.log(err);
    console.log(records);
});