import { ApolloClient, ApolloLink, InMemoryCache, gql } from '@apollo/client/core';

export const LIFT_PLAN_QUERY = gql`
  query LiftPlan($id: ID!) {
    liftPlan(id: $id) {
      id
      name
      revision
      status
      steps {
        id
        name
        loadRate
        clearance
      }
    }
  }
`;

export const graphqlClient = new ApolloClient({
  cache: new InMemoryCache(),
  link: ApolloLink.empty()
});
