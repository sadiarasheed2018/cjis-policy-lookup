// =====================================================================
// main.bicep
// Subscription-scoped Bicep that creates a resource group
// and a Static Web App inside it.
// =====================================================================

targetScope = 'subscription'

// ----- Parameters (values the user provides at deploy time) -----------
@description('Name of the resource group to create')
param resourceGroupName string = 'bicep-learning-rg'

@description('Azure region for all resources')
param location string = 'centralus'

@description('Name of the Static Web App (must be globally unique)')
param staticWebAppName string

// ----- Resource 1: The Resource Group ---------------------------------
resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    purpose: 'bicep-learning'
    owner: 'sadia'
  }
}

// ----- Resource 2: The Static Web App (inside the RG) -----------------
module swa 'staticwebapp.bicep' = {
  name: 'deploy-swa'
  scope: rg
  params: {
    name: staticWebAppName
    location: location
  }
}

// ----- Outputs (values returned after deploy) -------------------------
output resourceGroupId string = rg.id
output staticWebAppHostname string = swa.outputs.hostname