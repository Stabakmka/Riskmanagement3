// Import the cds facade object (https://cap.cloud.sap/docs/node.js/cds-facade)
const cds = require('@sap/cds')

// The service implementation with all service handlers
module.exports = cds.service.impl(async function () {

    // Define constants for the Risk and BusinessPartner entities from the risk-service.cds file
    const { Risks, BusinessPartners } = this.entities;

    // Utility function to ensure array format
    const asArray = x => Array.isArray(x) ? x : [x];

    // Simple in-memory cache for BusinessPartners with TTL
    const bpCache = new Map();
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // This handler will be executed directly AFTER a READ operation on RISKS
    // With this we can loop through the received data set and manipulate the single risk entries
    this.after("READ", Risks, (data) => {
        if (!data) return;
        
        // Convert to array, if it's only a single risk, so that the code won't break here
        const risks = asArray(data);

        // Looping through the array of risks to set the virtual field 'criticality' that you defined in the schema
        for (const risk of risks) {
            if (!risk) continue;
            
            // Set impact criticality
            risk.criticality = risk.impact >= 100000 ? 1 : 2;

            // Set priority criticality using more efficient approach
            switch (risk.prio_code) {
                case 'H':
                    risk.PrioCriticality = 1;
                    break;
                case 'M':
                    risk.PrioCriticality = 2;
                    break;
                case 'L':
                    risk.PrioCriticality = 3;
                    break;
                default:
                    risk.PrioCriticality = null;
                    break;
            }
        }
    })

    // connect to remote service
    const BPsrv = await cds.connect.to("API_BUSINESS_PARTNER");

    /**
     * Event-handler for read-events on the BusinessPartners entity.
     * Each request to the API Business Hub requires the apikey in the header.
     */
    this.on("READ", BusinessPartners, async (req) => {
        try {
            // The API Sandbox returns alot of business partners with empty names.
            // We don't want them in our application
            req.query.where("LastName <> '' and FirstName <> '' ");

            return await BPsrv.transaction(req).send({
                query: req.query,
                headers: {
                    apikey: process.env.apikey,
                },
            });
        } catch (error) {
            console.error('Error fetching BusinessPartners:', error.message);
            // Return empty array instead of failing completely
            return [];
        }
    });


    // Risks?$expand=bp (Expand on BusinessPartner)
    this.on("READ", Risks, async (req, next) => {
        /*
         Check whether the request wants an "expand" of the business partner
         As this is not possible, the risk entity and the business partner entity are in different systems (SAP BTP and S/4 HANA Cloud), 
         if there is such an expand, remove it
       */
        if (!req.query.SELECT.columns) return next();

        const expandIndex = req.query.SELECT.columns.findIndex(
            ({ expand, ref }) => expand && ref[0] === "bp"
        );

        if (expandIndex < 0) return next();

        // Remove expand from query
        req.query.SELECT.columns.splice(expandIndex, 1);

        // Make sure bp_BusinessPartner (ID) will be returned
        if (!req.query.SELECT.columns.find((column) =>
            column.ref.find((ref) => ref == "bp_BusinessPartner")
        )
        ) {
            req.query.SELECT.columns.push({ ref: ["bp_BusinessPartner"] });
        }

        const risks = await next();
        if (!risks || (Array.isArray(risks) && risks.length === 0)) {
            return risks;
        }

        // Get unique, valid BusinessPartner IDs
        const risksArray = asArray(risks);
        const bpIDs = [...new Set(
            risksArray
                .map(risk => risk.bp_BusinessPartner)
                .filter(id => id != null && id !== '')
        )];

        if (bpIDs.length === 0) {
            return risks;
        }

        // Check cache first and separate cached vs uncached IDs
        const now = Date.now();
        const cachedBPs = new Map();
        const uncachedIDs = [];

        for (const id of bpIDs) {
            const cached = bpCache.get(id);
            if (cached && (now - cached.timestamp) < CACHE_TTL) {
                cachedBPs.set(id, cached.data);
            } else {
                uncachedIDs.push(id);
            }
        }

        // Fetch uncached BusinessPartners
        let fetchedBPs = [];
        if (uncachedIDs.length > 0) {
            try {
                fetchedBPs = await BPsrv.transaction(req).send({
                    query: SELECT.from(this.entities.BusinessPartners).where({ BusinessPartner: uncachedIDs }),
                    headers: {
                        apikey: process.env.apikey,
                    }
                });

                // Update cache with fetched data
                for (const bp of fetchedBPs) {
                    bpCache.set(bp.BusinessPartner, {
                        data: bp,
                        timestamp: now
                    });
                    cachedBPs.set(bp.BusinessPartner, bp);
                }
            } catch (error) {
                console.warn('Failed to fetch BusinessPartners:', error.message);
                // Continue without BP data rather than failing completely
            }
        }

        // Add BusinessPartners to result using efficient Map lookup
        for (const risk of risksArray) {
            if (risk.bp_BusinessPartner) {
                risk.bp = cachedBPs.get(risk.bp_BusinessPartner) || null;
            }
        }

        return risks;
    });

});