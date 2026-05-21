// =====================================================================
// staticwebapp.bicep
// Resource-group-scoped module that creates a Static Web App.
// Called from main.bicep.
// =====================================================================

@description('Name of the Static Web App')
param name string

@description('Azure region')
param location string

// ----- The Static Web App resource ------------------------------------
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    // Not linked to a GitHub repo — this is just the resource itself.
    // We could add repositoryUrl, branch, repositoryToken here to wire it up.
    allowConfigFileUpdates: true
  }
}

// ----- Outputs --------------------------------------------------------
output hostname string = swa.properties.defaultHostname
output id string = swa.id